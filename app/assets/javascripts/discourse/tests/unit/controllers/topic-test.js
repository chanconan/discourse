import { module, test } from "qunit";
import { setupTest } from "ember-qunit";
import { settled } from "@ember/test-helpers";
import pretender, { response } from "discourse/tests/helpers/create-pretender";
import EmberObject from "@ember/object";
import { Placeholder } from "discourse/lib/posts-with-placeholders";
import Topic from "discourse/models/topic";
import User from "discourse/models/user";
import { next } from "@ember/runloop";

function topicWithStream(streamDetails) {
  let topic = Topic.create();
  topic.postStream.setProperties(streamDetails);
  return topic;
}

module("Unit | Controller | topic", function (hooks) {
  setupTest(hooks);

  test("editTopic", function (assert) {
    const controller = this.owner.lookup("controller:topic");
    const model = Topic.create();
    controller.setProperties({ model });
    assert.notOk(controller.editingTopic, "we are not editing by default");

    controller.set("model.details.can_edit", false);
    controller.editTopic();

    assert.notOk(
      controller.editingTopic,
      "calling editTopic doesn't enable editing unless the user can edit"
    );

    controller.set("model.details.can_edit", true);
    controller.editTopic();

    assert.ok(
      controller.editingTopic,
      "calling editTopic enables editing if the user can edit"
    );
    assert.strictEqual(controller.buffered.title, model.title);
    assert.strictEqual(controller.buffered.category_id, model.category_id);

    controller.send("cancelEditingTopic");

    assert.notOk(
      controller.editingTopic,
      "cancelling edit mode reverts the property value"
    );
  });

  test("deleteTopic", function (assert) {
    const model = Topic.create();
    let destroyed = false;
    let modalDisplayed = false;
    model.destroy = async () => (destroyed = true);

    const siteSettings = this.owner.lookup("service:site-settings");
    siteSettings.min_topic_views_for_delete_confirm = 5;

    const controller = this.owner.lookup("controller:topic");
    controller.setProperties({
      model,
      deleteTopicModal: () => (modalDisplayed = true),
    });

    model.set("views", 10000);
    controller.send("deleteTopic");
    assert.notOk(destroyed, "don't destroy popular topic");
    assert.ok(modalDisplayed, "display confirmation modal for popular topic");

    model.set("views", 3);
    controller.send("deleteTopic");
    assert.ok(destroyed, "destroy not popular topic");
  });

  test("deleteTopic permanentDelete", function (assert) {
    const model = Topic.create();
    let destroyed = false;
    model.destroy = async () => (destroyed = true);

    const siteSettings = this.owner.lookup("service:site-settings");
    siteSettings.min_topic_views_for_delete_confirm = 5;

    const controller = this.owner.lookup("controller:topic");
    controller.setProperties({
      model,
    });

    model.set("views", 100);
    controller.send("deleteTopic", { force_destroy: true });

    assert.ok(
      destroyed,
      "do not show delete confirm when permanently deleting topic"
      // permanent delete happens after first delete, no need to show modal again
    );
  });

  test("toggleMultiSelect", async function (assert) {
    const model = Topic.create();
    const controller = this.owner.lookup("controller:topic");
    controller.setProperties({ model });

    assert.notOk(
      controller.multiSelect,
      "multi selection mode is disabled by default"
    );

    controller.selectedPostIds.pushObject(1);
    assert.strictEqual(controller.selectedPostIds.length, 1);

    controller.send("toggleMultiSelect");
    await settled();

    assert.ok(
      controller.multiSelect,
      "calling 'toggleMultiSelect' once enables multi selection mode"
    );
    assert.strictEqual(
      controller.selectedPostIds.length,
      0,
      "toggling 'multiSelect' clears 'selectedPostIds'"
    );

    controller.selectedPostIds.pushObject(2);
    assert.strictEqual(controller.selectedPostIds.length, 1);

    controller.send("toggleMultiSelect");
    await settled();

    assert.notOk(
      controller.multiSelect,
      "calling 'toggleMultiSelect' twice disables multi selection mode"
    );
    assert.strictEqual(
      controller.selectedPostIds.length,
      0,
      "toggling 'multiSelect' clears 'selectedPostIds'"
    );
  });

  test("selectedPosts", function (assert) {
    const model = topicWithStream({ posts: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    const controller = this.owner.lookup("controller:topic");
    controller.setProperties({ model });

    controller.set("selectedPostIds", [1, 2, 42]);

    assert.strictEqual(
      controller.selectedPosts.length,
      2,
      "selectedPosts only contains already loaded posts"
    );
    assert.notOk(
      controller.selectedPosts.some((p) => p === undefined),
      "selectedPosts only contains valid post objects"
    );
  });

  test("selectedAllPosts", function (assert) {
    const model = topicWithStream({ stream: [1, 2, 3] });
    const controller = this.owner.lookup("controller:topic");
    controller.setProperties({ model });

    controller.set("selectedPostIds", [1, 2]);
    assert.notOk(controller.selectedAllPosts, "not all posts are selected");

    controller.selectedPostIds.pushObject(3);
    assert.ok(controller.selectedAllPosts, "all posts are selected");

    controller.selectedPostIds.pushObject(42);
    assert.ok(
      controller.selectedAllPosts,
      "all posts (including filtered posts) are selected"
    );

    model.setProperties({
      "postStream.isMegaTopic": true,
      posts_count: 1,
    });
    assert.ok(
      controller.selectedAllPosts,
      "it uses the topic's post count for mega-topics"
    );
  });

  test("selectedPostsUsername", function (assert) {
    const model = topicWithStream({
      posts: [
        { id: 1, username: "gary" },
        { id: 2, username: "gary" },
        { id: 3, username: "lili" },
      ],
      stream: [1, 2, 3],
    });
    const controller = this.owner.lookup("controller:topic");
    controller.setProperties({ model });

    assert.strictEqual(
      controller.selectedPostsUsername,
      undefined,
      "no username when no selected posts"
    );

    controller.selectedPostIds.pushObject(1);
    assert.strictEqual(
      controller.selectedPostsUsername,
      "gary",
      "username of the selected posts"
    );

    controller.selectedPostIds.pushObject(2);
    assert.strictEqual(
      controller.selectedPostsUsername,
      "gary",
      "username of all the selected posts when same user"
    );

    controller.selectedPostIds.pushObject(3);
    assert.strictEqual(
      controller.selectedPostsUsername,
      undefined,
      "no username when more than 1 user"
    );

    controller.selectedPostIds.replace(2, 1, [42]);
    assert.strictEqual(
      controller.selectedPostsUsername,
      undefined,
      "no username when not already loaded posts are selected"
    );
  });

  test("showSelectedPostsAtBottom", function (assert) {
    const model = Topic.create({ posts_count: 3 });
    const controller = this.owner.lookup("controller:topic");
    controller.setProperties({ model });

    assert.notOk(controller.showSelectedPostsAtBottom, "false on desktop");

    const site = this.owner.lookup("service:site");
    site.set("mobileView", true);

    assert.notOk(
      controller.showSelectedPostsAtBottom,
      "requires at least 3 posts on mobile"
    );

    model.set("posts_count", 4);
    assert.ok(
      controller.showSelectedPostsAtBottom,
      "true when mobile and more than 3 posts"
    );
  });

  test("canDeleteSelected", function (assert) {
    const currentUser = User.create({ admin: false });
    const model = topicWithStream({
      posts: [
        { id: 1, can_delete: false },
        { id: 2, can_delete: true },
        { id: 3, can_delete: true },
      ],
      stream: [1, 2, 3],
    });

    const controller = this.owner.lookup("controller:topic");
    controller.setProperties({
      model,
      currentUser,
    });

    assert.notOk(
      controller.canDeleteSelected,
      "false when no posts are selected"
    );

    controller.selectedPostIds.pushObject(1);
    assert.notOk(
      controller.canDeleteSelected,
      "false when can't delete one of the selected posts"
    );

    controller.selectedPostIds.replace(0, 1, [2, 3]);
    assert.ok(
      controller.canDeleteSelected,
      "true when all selected posts can be deleted"
    );

    controller.selectedPostIds.pushObject(1);
    assert.notOk(
      controller.canDeleteSelected,
      "false when all posts are selected and user is staff"
    );

    currentUser.set("admin", true);
    assert.ok(
      controller.canDeleteSelected,
      "true when all posts are selected and user is staff"
    );
  });

  test("Can split/merge topic", function (assert) {
    const model = topicWithStream({
      posts: [
        { id: 1, post_number: 1, post_type: 1 },
        { id: 2, post_number: 2, post_type: 4 },
        { id: 3, post_number: 3, post_type: 1 },
      ],
      stream: [1, 2, 3],
    });
    model.set("details.can_move_posts", false);

    const controller = this.owner.lookup("controller:topic");
    controller.setProperties({ model });

    assert.notOk(
      controller.canMergeTopic,
      "can't merge topic when no posts are selected"
    );

    controller.selectedPostIds.pushObject(1);

    assert.notOk(
      controller.canMergeTopic,
      "can't merge topic when can't move posts"
    );

    model.set("details.can_move_posts", true);

    assert.ok(controller.canMergeTopic, "can merge topic");

    controller.selectedPostIds.removeObject(1);
    controller.selectedPostIds.pushObject(2);

    assert.ok(
      controller.canMergeTopic,
      "can merge topic when 1st post is not a regular post"
    );

    controller.selectedPostIds.pushObject(3);

    assert.ok(
      controller.canMergeTopic,
      "can merge topic when all posts are selected"
    );
  });

  test("canChangeOwner", function (assert) {
    const currentUser = User.create({ admin: false });
    const model = topicWithStream({
      posts: [
        { id: 1, username: "gary" },
        { id: 2, username: "lili" },
      ],
      stream: [1, 2],
    });
    model.set("currentUser", currentUser);

    const controller = this.owner.lookup("controller:topic");
    controller.setProperties({ model, currentUser });

    assert.notOk(controller.canChangeOwner, "false when no posts are selected");

    controller.selectedPostIds.pushObject(1);
    assert.notOk(controller.canChangeOwner, "false when not admin");

    currentUser.set("admin", true);
    assert.ok(
      controller.canChangeOwner,
      "true when admin and one post is selected"
    );

    controller.selectedPostIds.pushObject(2);
    assert.notOk(
      controller.canChangeOwner,
      "false when admin but more than 1 user"
    );
  });

  test("modCanChangeOwner", function (assert) {
    const currentUser = User.create({ moderator: false });
    const model = topicWithStream({
      posts: [
        { id: 1, username: "gary" },
        { id: 2, username: "lili" },
      ],
      stream: [1, 2],
    });
    model.set("currentUser", currentUser);

    const siteSettings = this.owner.lookup("service:site-settings");
    siteSettings.moderators_change_post_ownership = true;

    const controller = this.owner.lookup("controller:topic");
    controller.setProperties({ model, currentUser });

    assert.notOk(controller.canChangeOwner, "false when no posts are selected");

    controller.selectedPostIds.pushObject(1);
    assert.notOk(controller.canChangeOwner, "false when not moderator");

    currentUser.set("moderator", true);
    assert.ok(
      controller.canChangeOwner,
      "true when moderator and one post is selected"
    );

    controller.selectedPostIds.pushObject(2);
    assert.notOk(
      controller.canChangeOwner,
      "false when moderator but more than 1 user"
    );
  });

  test("canMergePosts", function (assert) {
    const model = topicWithStream({
      posts: [
        { id: 1, username: "gary", can_delete: true },
        { id: 2, username: "lili", can_delete: true },
        { id: 3, username: "gary", can_delete: false },
        { id: 4, username: "gary", can_delete: true },
      ],
      stream: [1, 2, 3],
    });

    const controller = this.owner.lookup("controller:topic");
    controller.setProperties({ model });

    assert.notOk(controller.canMergePosts, "false when no posts are selected");

    controller.selectedPostIds.pushObject(1);
    assert.notOk(
      controller.canMergePosts,
      "false when only one post is selected"
    );

    controller.selectedPostIds.pushObject(2);
    assert.notOk(
      controller.canMergePosts,
      "false when selected posts are from different users"
    );

    controller.selectedPostIds.replace(1, 1, [3]);
    assert.notOk(
      controller.canMergePosts,
      "false when selected posts can't be deleted"
    );

    controller.selectedPostIds.replace(1, 1, [4]);
    assert.ok(
      controller.canMergePosts,
      "true when all selected posts are deletable and by the same user"
    );
  });

  test("Select/deselect all", function (assert) {
    const controller = this.owner.lookup("controller:topic");
    const model = topicWithStream({ stream: [1, 2, 3] });
    controller.setProperties({ model });

    assert.strictEqual(
      controller.selectedPostsCount,
      0,
      "no posts selected by default"
    );

    controller.send("selectAll");
    assert.strictEqual(
      controller.selectedPostsCount,
      3,
      "calling 'selectAll' selects all posts"
    );

    controller.send("deselectAll");
    assert.strictEqual(
      controller.selectedPostsCount,
      0,
      "calling 'deselectAll' deselects all posts"
    );
  });

  test("togglePostSelection", function (assert) {
    const controller = this.owner.lookup("controller:topic");

    assert.strictEqual(
      controller.selectedPostIds[0],
      undefined,
      "no posts selected by default"
    );

    controller.send("togglePostSelection", { id: 1 });
    assert.strictEqual(
      controller.selectedPostIds[0],
      1,
      "adds the selected post id if not already selected"
    );

    controller.send("togglePostSelection", { id: 1 });
    assert.strictEqual(
      controller.selectedPostIds[0],
      undefined,
      "removes the selected post id if already selected"
    );
  });

  test("selectBelow", function (assert) {
    const site = this.owner.lookup("service:site");
    site.set("post_types", { small_action: 3, whisper: 4 });

    const model = topicWithStream({
      stream: [1, 2, 3, 4, 5, 6, 7, 8],
      posts: [
        { id: 5, cooked: "whisper post", post_type: 4 },
        { id: 6, cooked: "a small action", post_type: 3 },
        { id: 7, cooked: "", post_type: 4 },
      ],
    });

    const controller = this.owner.lookup("controller:topic");
    controller.setProperties({ model });

    assert.deepEqual(
      controller.selectedPostIds,
      [],
      "no posts selected by default"
    );

    controller.send("selectBelow", { id: 3 });
    assert.deepEqual(controller.selectedPostIds, [3, 4, 5, 8]);
  });

  test("selectReplies", async function (assert) {
    pretender.get("/posts/1/reply-ids.json", () =>
      response([{ id: 2, level: 1 }])
    );

    const model = topicWithStream({
      posts: [{ id: 1 }, { id: 2 }],
    });

    const controller = this.owner.lookup("controller:topic");
    controller.setProperties({ model });

    controller.send("selectReplies", { id: 1 });
    await settled();

    assert.strictEqual(
      controller.selectedPostsCount,
      2,
      "It should select two, the post and its replies"
    );

    controller.send("togglePostSelection", { id: 1 });
    assert.strictEqual(
      controller.selectedPostsCount,
      1,
      "It should be selecting one only "
    );
    assert.strictEqual(
      controller.selectedPostIds[0],
      2,
      "It should be selecting the reply id "
    );

    controller.send("selectReplies", { id: 1 });
    await settled();

    assert.strictEqual(
      controller.selectedPostsCount,
      2,
      "It should be selecting two, even if reply was already selected"
    );
  });

  test("topVisibleChanged", function (assert) {
    const model = topicWithStream({
      posts: [{ id: 1 }],
    });
    const controller = this.owner.lookup("controller:topic");
    controller.setProperties({ model });
    const placeholder = new Placeholder("post-placeholder");

    assert.strictEqual(
      controller.send("topVisibleChanged", {
        post: placeholder,
      }),
      undefined,
      "it should work with a post-placeholder"
    );
  });

  test("deletePost - no modal is shown if post does not have replies", function (assert) {
    pretender.get("/posts/2/reply-ids.json", () => response([]));

    let destroyed;
    const post = EmberObject.create({
      id: 2,
      post_number: 2,
      can_delete: true,
      reply_count: 3,
      destroy: async () => (destroyed = true),
    });

    const currentUser = EmberObject.create({ moderator: true });
    const model = topicWithStream({
      stream: [2, 3, 4],
      posts: [post, { id: 3 }, { id: 4 }],
    });

    const controller = this.owner.lookup("controller:topic");
    controller.setProperties({ model, currentUser });

    const done = assert.async();
    controller.send("deletePost", post);

    next(() => {
      assert.ok(destroyed, "post was destroyed");
      done();
    });
  });
});
