/**
 * An example plugin: Settings › Plugins › Install from folder…, pick this
 * folder, and switch it on. Installing it again after an edit updates it.
 *
 * `onload` is handed the app — `PluginApp` in `src/renderer/lib/plugins/app.ts`.
 * Everything registered through it is taken back when the plugin is switched
 * off, so there is nothing to undo in an `onunload` here.
 */
export default {
  async onload(app) {
    const saved = (await app.loadData()) ?? { finished: 0 }

    app.addCommand({
      id: "count",
      name: "Count chats",
      run() {
        const chats = app.chats.list()
        const folders = app.folders().length
        app.notice(
          `${chats.length} chats in ${folders} projects; ` +
            `${saved.finished} finished while this plugin was on.`
        )
      },
    })

    // `busy: false` is the chat going quiet — `done` is only the end of a
    // turn, and another message may already be queued behind it.
    app.chats.onEvent((event) => {
      if (event.type !== "busy" || event.busy) return
      saved.finished += 1
      void app.saveData(saved)
      const chat = app.chats.list().find((entry) => entry.id === event.chatId)
      app.notice(`${chat?.title ?? "A chat"} is done.`)
    })
  },
}
