# frozen_string_literal: true

require "mini_mime"

class UploadsController < ApplicationController
  include ExternalUploadHelpers

  requires_login

  skip_before_action :preload_json, :check_xhr, :redirect_to_login_if_required, only: [:show, :show_short, :_show_secure_deprecated, :show_secure]
  protect_from_forgery except: :show

  before_action :is_asset_path, :apply_cdn_headers, only: [:show, :show_short, :_show_secure_deprecated, :show_secure]
  before_action :external_store_check, only: [:_show_secure_deprecated, :show_secure]

  SECURE_REDIRECT_GRACE_SECONDS = 5

  def create
    # capture current user for block later on
    me = current_user

    params.permit(:type, :upload_type)
    if params[:type].blank? && params[:upload_type].blank?
      raise Discourse::InvalidParameters
    end
    # 50 characters ought to be enough for the upload type
    type = (params[:upload_type].presence || params[:type].presence).parameterize(separator: "_")[0..50]

    if type == "avatar" && !me.admin? && (SiteSetting.discourse_connect_overrides_avatar || !TrustLevelAndStaffAndDisabledSetting.matches?(SiteSetting.allow_uploaded_avatars, me))
      return render json: failed_json, status: 422
    end

    url    = params[:url]
    file   = params[:file] || params[:files]&.first
    pasted = params[:pasted] == "true"
    for_private_message = params[:for_private_message] == "true"
    for_site_setting = params[:for_site_setting] == "true"
    is_api = is_api?
    retain_hours = params[:retain_hours].to_i

    # note, atm hijack is processed in its own context and has not access to controller
    # longer term we may change this
    hijack do
      begin
        info = UploadsController.create_upload(
          current_user: me,
          file: file,
          url: url,
          type: type,
          for_private_message: for_private_message,
          for_site_setting: for_site_setting,
          pasted: pasted,
          is_api: is_api,
          retain_hours: retain_hours
        )
      rescue => e
        render json: failed_json.merge(message: e.message&.split("\n")&.first), status: 422
      else
        render json: UploadsController.serialize_upload(info), status: Upload === info ? 200 : 422
      end
    end
  end

  def lookup_urls
    params.permit(short_urls: [])
    uploads = []

    if (params[:short_urls] && params[:short_urls].length > 0)
      PrettyText::Helpers.lookup_upload_urls(params[:short_urls]).each do |short_url, paths|
        uploads << {
          short_url: short_url,
          url: paths[:url],
          short_path: paths[:short_path]
        }
      end
    end

    render json: uploads.to_json
  end

  def show
    # do not serve uploads requested via XHR to prevent XSS
    return xhr_not_allowed if request.xhr?

    return render_404 if !RailsMultisite::ConnectionManagement.has_db?(params[:site])

    RailsMultisite::ConnectionManagement.with_connection(params[:site]) do |db|
      return render_404 if SiteSetting.prevent_anons_from_downloading_files && current_user.nil?

      if upload = Upload.find_by(sha1: params[:sha]) || Upload.find_by(id: params[:id], url: request.env["PATH_INFO"])
        unless Discourse.store.internal?
          local_store = FileStore::LocalStore.new
          return render_404 unless local_store.has_been_uploaded?(upload.url)
        end

        send_file_local_upload(upload)
      else
        render_404
      end
    end
  end

  def show_short
    # do not serve uploads requested via XHR to prevent XSS
    return xhr_not_allowed if request.xhr?

    if SiteSetting.prevent_anons_from_downloading_files && current_user.nil?
      return render_404
    end

    sha1 = Upload.sha1_from_base62_encoded(params[:base62])

    if upload = Upload.find_by(sha1: sha1)
      if upload.secure? && SiteSetting.secure_uploads?
        return handle_secure_upload_request(upload)
      end

      if Discourse.store.internal?
        send_file_local_upload(upload)
      else
        redirect_to Discourse.store.url_for(upload, force_download: force_download?), allow_other_host: true
      end
    else
      render_404
    end
  end

  # Kept to avoid rebaking old posts with /show-secure-uploads/ in their
  # contents, this will ensure the uploads in these posts continue to
  # work in future.
  def _show_secure_deprecated
    show_secure
  end

  def show_secure
    # do not serve uploads requested via XHR to prevent XSS
    return xhr_not_allowed if request.xhr?

    path_with_ext = "#{params[:path]}.#{params[:extension]}"

    sha1 = File.basename(path_with_ext, File.extname(path_with_ext))
    # this takes care of optimized image requests
    sha1 = sha1.partition("_").first if sha1.include?("_")

    upload = Upload.find_by(sha1: sha1)
    return render_404 if upload.blank?

    return render_404 if SiteSetting.prevent_anons_from_downloading_files && current_user.nil?
    return handle_secure_upload_request(upload, path_with_ext) if SiteSetting.secure_uploads?

    # we don't want to 404 here if secure uploads gets disabled
    # because all posts with secure uploads will show broken media
    # until rebaked, which could take some time
    #
    # if the upload is still secure, that means the ACL is probably still
    # private, so we don't want to go to the CDN url just yet otherwise we
    # will get a 403. if the upload is not secure we assume the ACL is public
    signed_secure_url = Discourse.store.signed_url_for_path(path_with_ext)
    redirect_to upload.secure? ? signed_secure_url : Discourse.store.cdn_url(upload.url), allow_other_host: true
  end

  def handle_secure_upload_request(upload, path_with_ext = nil)
    if upload.access_control_post_id.present?
      raise Discourse::InvalidAccess if !guardian.can_see?(upload.access_control_post)
    else
      return render_404 if current_user.nil?
    end

    # defaults to public: false, so only cached by the client browser
    cache_seconds = SiteSetting.s3_presigned_get_url_expires_after_seconds - SECURE_REDIRECT_GRACE_SECONDS
    expires_in cache_seconds.seconds

    # url_for figures out the full URL, handling multisite DBs,
    # and will return a presigned URL for the upload
    if path_with_ext.blank?
      return redirect_to Discourse.store.url_for(upload, force_download: force_download?), allow_other_host: true
    end

    redirect_to Discourse.store.signed_url_for_path(
      path_with_ext,
      expires_in: SiteSetting.s3_presigned_get_url_expires_after_seconds,
      force_download: force_download?
    ), allow_other_host: true
  end

  def metadata
    params.require(:url)
    upload = Upload.get_from_url(params[:url])
    raise Discourse::NotFound unless upload

    render json: {
      original_filename: upload.original_filename,
      width: upload.width,
      height: upload.height,
      human_filesize: upload.human_filesize
    }
  end

  protected

  def validate_before_create_multipart(file_name:, file_size:, upload_type:)
    validate_file_size(file_name: file_name, file_size: file_size)
  end

  def validate_before_create_direct_upload(file_name:, file_size:, upload_type:)
    validate_file_size(file_name: file_name, file_size: file_size)
  end

  def validate_file_size(file_name:, file_size:)
    if file_size.zero?
      raise ExternalUploadValidationError.new(I18n.t("upload.size_zero_failure"))
    end

    if file_size_too_big?(file_name, file_size)
      raise ExternalUploadValidationError.new(
        I18n.t(
          "upload.attachments.too_large_humanized",
          max_size: ActiveSupport::NumberHelper.number_to_human_size(SiteSetting.max_attachment_size_kb.kilobytes)
        )
      )
    end
  end

  def force_download?
    params[:dl] == "1"
  end

  def xhr_not_allowed
    raise Discourse::InvalidParameters.new("XHR not allowed")
  end

  def self.serialize_upload(data)
    # as_json.as_json is not a typo... as_json in AM serializer returns keys as symbols, we need them
    # as strings here
    serialized = UploadSerializer.new(data, root: nil).as_json.as_json if Upload === data
    serialized ||= (data || {}).as_json
  end

  def self.create_upload(current_user:,
                         file:,
                         url:,
                         type:,
                         for_private_message:,
                         for_site_setting:,
                         pasted:,
                         is_api:,
                         retain_hours:)

    if file.nil?
      if url.present? && is_api
        maximum_upload_size = [SiteSetting.max_image_size_kb, SiteSetting.max_attachment_size_kb].max.kilobytes
        tempfile = FileHelper.download(
          url,
          follow_redirect: true,
          max_file_size: maximum_upload_size,
          tmp_file_name: "discourse-upload-#{type}"
        ) rescue nil
        filename = File.basename(URI.parse(url).path)
      end
    else
      tempfile = file.tempfile
      filename = file.original_filename
    end

    return { errors: [I18n.t("upload.file_missing")] } if tempfile.nil?

    opts = {
      type: type,
      for_private_message: for_private_message,
      for_site_setting: for_site_setting,
      pasted: pasted,
    }

    upload = UploadCreator.new(tempfile, filename, opts).create_for(current_user.id)

    if upload.errors.empty? && current_user.admin?
      upload.update_columns(retain_hours: retain_hours) if retain_hours > 0
    end

    upload.errors.empty? ? upload : { errors: upload.errors.to_hash.values.flatten }
  ensure
    tempfile&.close!
  end

  private

  # We can pre-emptively check size for attachments, but not for images
  # as they may be further reduced in size by UploadCreator (at this point
  # they may have already been reduced in size by preprocessors)
  def file_size_too_big?(file_name, file_size)
    !FileHelper.is_supported_image?(file_name) && file_size >= SiteSetting.max_attachment_size_kb.kilobytes
  end

  def send_file_local_upload(upload)
    opts = {
      filename: upload.original_filename,
      content_type: MiniMime.lookup_by_filename(upload.original_filename)&.content_type
    }

    if !FileHelper.is_inline_image?(upload.original_filename)
      opts[:disposition] = "attachment"
    elsif params[:inline]
      opts[:disposition] = "inline"
    end

    file_path = Discourse.store.path_for(upload)
    return render_404 unless file_path

    send_file(file_path, opts)
  end

  def create_direct_multipart_upload
    begin
      yield
    rescue Aws::S3::Errors::ServiceError => err
      message = debug_upload_error(err, I18n.t("upload.create_multipart_failure", additional_detail: err.message))
      raise ExternalUploadHelpers::ExternalUploadValidationError.new(message)
    end
  end
end
