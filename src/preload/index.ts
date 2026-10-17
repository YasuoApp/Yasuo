import {
  contextBridge,
  ipcRenderer,
  webUtils,
  type IpcRendererEvent,
} from "electron"

import {
  IPC,
  type DesktopApi,
  type DirectoryChange,
  type TreeChange,
  type MenuCommand,
  type ChatEvent,
  type TerminalExit,
  type TerminalOutput,
  type UpdateProgress,
} from "../shared/api"

/**
 * Subscribes to a main-process event, handing the listener only the payload.
 * The `IpcRendererEvent` is deliberately not passed through: it carries a
 * `sender` the renderer has no business holding.
 */
function subscribe<T>(channel: string, listener: (payload: T) => void) {
  const handler = (_event: IpcRendererEvent, payload: T) => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.off(channel, handler)
  }
}

const api: DesktopApi = {
  // `process.platform` is one of the few things a sandboxed preload still has.
  platform: process.platform as DesktopApi["platform"],

  getWorkspace: () => ipcRenderer.invoke(IPC.getWorkspace),
  addFolder: (input) => ipcRenderer.invoke(IPC.addFolder, input),
  createProject: (input) => ipcRenderer.invoke(IPC.createProject, input),
  trashProject: (folderId) => ipcRenderer.invoke(IPC.trashProject, folderId),
  renameFolder: (id, name) => ipcRenderer.invoke(IPC.renameFolder, id, name),
  removeFolder: (id) => ipcRenderer.invoke(IPC.removeFolder, id),
  addWorktree: (input) => ipcRenderer.invoke(IPC.addWorktree, input),
  removeWorktree: (folderId, options) =>
    ipcRenderer.invoke(IPC.removeWorktree, folderId, options),
  worktreeOptions: (folderId) =>
    ipcRenderer.invoke(IPC.worktreeOptions, folderId),
  worktreeStatus: (folderId) =>
    ipcRenderer.invoke(IPC.worktreeStatus, folderId),
  nameWorktree: (folderId, title) =>
    ipcRenderer.invoke(IPC.nameWorktree, folderId, title),

  pickDirectory: () => ipcRenderer.invoke(IPC.pickDirectory),
  pickFiles: (directory) => ipcRenderer.invoke(IPC.pickFiles, directory),
  // Never leaves this script: `webUtils` only resolves a real path for a
  // `File` from inside the preload's own privileged context.
  getPathForFile: (file) => webUtils.getPathForFile(file),
  clipboardImagePath: () => ipcRenderer.invoke(IPC.clipboardImagePath),

  onMenuCommand: (listener) =>
    subscribe<MenuCommand>(IPC.menuCommand, listener),

  gitBranch: (folderId) => ipcRenderer.invoke(IPC.gitBranch, folderId),
  gitWorktreeRepo: (folderId) =>
    ipcRenderer.invoke(IPC.gitWorktreeRepo, folderId),
  gitStatus: (folderId) => ipcRenderer.invoke(IPC.gitStatus, folderId),
  gitChanges: (folderId) => ipcRenderer.invoke(IPC.gitChanges, folderId),
  gitLog: (folderId, limit, skip, query) =>
    ipcRenderer.invoke(IPC.gitLog, folderId, limit, skip, query),
  gitUpstream: (folderId) => ipcRenderer.invoke(IPC.gitUpstream, folderId),
  gitCommitFiles: (folderId, hash) =>
    ipcRenderer.invoke(IPC.gitCommitFiles, folderId, hash),
  gitCommitFileDiff: (folderId, hash, path, from) =>
    ipcRenderer.invoke(IPC.gitCommitFileDiff, folderId, hash, path, from),
  gitStage: (folderId, paths) =>
    ipcRenderer.invoke(IPC.gitStage, folderId, paths),
  gitUnstage: (folderId, paths) =>
    ipcRenderer.invoke(IPC.gitUnstage, folderId, paths),
  gitDiscard: (folderId, paths) =>
    ipcRenderer.invoke(IPC.gitDiscard, folderId, paths),
  gitDiscardAll: (folderId) => ipcRenderer.invoke(IPC.gitDiscardAll, folderId),
  gitCommit: (folderId, message) =>
    ipcRenderer.invoke(IPC.gitCommit, folderId, message),
  gitPush: (folderId) => ipcRenderer.invoke(IPC.gitPush, folderId),
  draftCommitMessage: (folderId, model, effort, profileId) =>
    ipcRenderer.invoke(
      IPC.draftCommitMessage,
      folderId,
      model,
      effort,
      profileId
    ),
  cancelCommitDraft: (folderId) =>
    ipcRenderer.invoke(IPC.cancelCommitDraft, folderId),
  fileDiff: (filePath) => ipcRenderer.invoke(IPC.fileDiff, filePath),
  imageAtHead: (filePath) => ipcRenderer.invoke(IPC.imageAtHead, filePath),
  gitBlame: (filePath, text) =>
    ipcRenderer.invoke(IPC.gitBlame, filePath, text),
  gitLineHistory: (filePath, hash, path, line) =>
    ipcRenderer.invoke(IPC.gitLineHistory, filePath, hash, path, line),

  listDirectory: (dirPath) => ipcRenderer.invoke(IPC.listDirectory, dirPath),
  readTextFile: (filePath) => ipcRenderer.invoke(IPC.readTextFile, filePath),
  writeTextFile: (filePath, text) =>
    ipcRenderer.invoke(IPC.writeTextFile, filePath, text),
  createFile: (dirPath, name) =>
    ipcRenderer.invoke(IPC.createFile, dirPath, name),
  createDirectory: (dirPath, name) =>
    ipcRenderer.invoke(IPC.createDirectory, dirPath, name),
  renamePath: (target, name) =>
    ipcRenderer.invoke(IPC.renamePath, target, name),
  copyIntoDirectory: (dirPath, sources) =>
    ipcRenderer.invoke(IPC.copyIntoDirectory, dirPath, sources),
  movePath: (target, dirPath) =>
    ipcRenderer.invoke(IPC.movePath, target, dirPath),
  trashPath: (target) => ipcRenderer.invoke(IPC.trashPath, target),
  revealPath: (target) => ipcRenderer.invoke(IPC.revealPath, target),
  startDragPath: (target) => ipcRenderer.invoke(IPC.startDragPath, target),
  readImageFile: (filePath) => ipcRenderer.invoke(IPC.readImageFile, filePath),
  writeImageFile: (filePath, dataUrl) =>
    ipcRenderer.invoke(IPC.writeImageFile, filePath, dataUrl),
  readImageRelative: (dir, relative) =>
    ipcRenderer.invoke(IPC.readImageRelative, dir, relative),
  projectIcon: (folderId) => ipcRenderer.invoke(IPC.projectIcon, folderId),
  pickProjectIcon: (folderId) =>
    ipcRenderer.invoke(IPC.pickProjectIcon, folderId),
  resetProjectIcon: (folderId) =>
    ipcRenderer.invoke(IPC.resetProjectIcon, folderId),
  resolveRelativePath: (dir, relative) =>
    ipcRenderer.invoke(IPC.resolveRelativePath, dir, relative),
  listWorkspaceFiles: () => ipcRenderer.invoke(IPC.listWorkspaceFiles),
  watchDirectories: (dirs) => ipcRenderer.invoke(IPC.watchDirectories, dirs),
  onDirectoryChanged: (listener) =>
    subscribe<DirectoryChange>(IPC.directoryChanged, listener),
  onTreeChanged: (listener) => subscribe<TreeChange>(IPC.treeChanged, listener),

  tsOpen: (filePath, text) => ipcRenderer.invoke(IPC.tsOpen, filePath, text),
  tsChange: (filePath, text) =>
    ipcRenderer.invoke(IPC.tsChange, filePath, text),
  tsClose: (filePath) => ipcRenderer.invoke(IPC.tsClose, filePath),
  tsHover: (filePath, line, column) =>
    ipcRenderer.invoke(IPC.tsHover, filePath, line, column),
  tsDefinition: (filePath, line, column) =>
    ipcRenderer.invoke(IPC.tsDefinition, filePath, line, column),

  getSetting: (key) => ipcRenderer.invoke(IPC.getSetting, key),
  setSetting: (key, value) => ipcRenderer.invoke(IPC.setSetting, key, value),

  agentModels: () => ipcRenderer.invoke(IPC.agentModels),
  agentCommands: (folderId) => ipcRenderer.invoke(IPC.agentCommands, folderId),
  installedMcpServers: (folderId) =>
    ipcRenderer.invoke(IPC.installedMcpServers, folderId),
  planUsage: (profileId, fresh) =>
    ipcRenderer.invoke(IPC.planUsage, profileId, fresh),
  removeMcpServer: (input) => ipcRenderer.invoke(IPC.removeMcpServer, input),
  listClaudeProfiles: () => ipcRenderer.invoke(IPC.listClaudeProfiles),
  saveClaudeProfiles: (profiles) =>
    ipcRenderer.invoke(IPC.saveClaudeProfiles, profiles),
  claudeAccount: (configDir) =>
    ipcRenderer.invoke(IPC.claudeAccount, configDir),
  claudeVersions: () => ipcRenderer.invoke(IPC.claudeVersions),
  claudeLogin: (configDir, cols, rows) =>
    ipcRenderer.invoke(IPC.claudeLogin, configDir, cols, rows),
  listChats: () => ipcRenderer.invoke(IPC.listChats),
  createChat: (place, seed) => ipcRenderer.invoke(IPC.createChat, place, seed),
  readChat: (id) => ipcRenderer.invoke(IPC.readChat, id),
  chatSpend: () => ipcRenderer.invoke(IPC.chatSpend),
  saveTextFile: (input) => ipcRenderer.invoke(IPC.saveTextFile, input),
  openChatWindow: (chatId) => ipcRenderer.invoke(IPC.openChatWindow, chatId),
  setAlwaysOnTop: (on) => ipcRenderer.invoke(IPC.setAlwaysOnTop, on),
  isAlwaysOnTop: () => ipcRenderer.invoke(IPC.isAlwaysOnTop),
  setBadgeCount: (count) => ipcRenderer.invoke(IPC.setBadgeCount, count),
  signInWithGoogle: () => ipcRenderer.invoke(IPC.signInWithGoogle),
  cancelSignInWithGoogle: () => ipcRenderer.invoke(IPC.cancelSignInWithGoogle),
  freeAiAvailable: () => ipcRenderer.invoke(IPC.freeAiAvailable),
  setFreeAiToken: (token) => ipcRenderer.invoke(IPC.setFreeAiToken, token),
  searchWorkspace: (query, options, filter) =>
    ipcRenderer.invoke(IPC.searchWorkspace, query, options, filter),
  replaceInFiles: (query, options, replacement, paths) =>
    ipcRenderer.invoke(IPC.replaceInFiles, query, options, replacement, paths),
  deleteChat: (id) => ipcRenderer.invoke(IPC.deleteChat, id),
  clearChat: (id) => ipcRenderer.invoke(IPC.clearChat, id),
  renameChat: (id, title) => ipcRenderer.invoke(IPC.renameChat, id, title),
  setChatOptions: (id, options) =>
    ipcRenderer.invoke(IPC.setChatOptions, id, options),
  answerChatAsk: (askId, answer) =>
    ipcRenderer.invoke(IPC.answerChatAsk, askId, answer),
  sendChat: (id, prompt, images) =>
    ipcRenderer.invoke(IPC.sendChat, id, prompt, images),
  editChat: (id, at, prompt, restore) =>
    ipcRenderer.invoke(IPC.editChat, id, at, prompt, restore),
  stopChat: (id) => ipcRenderer.invoke(IPC.stopChat, id),
  onChatEvent: (listener) => subscribe<ChatEvent>(IPC.chatEvent, listener),
  onRevealChat: (listener) => subscribe<string>(IPC.revealChat, listener),
  readDrawing: (id) => ipcRenderer.invoke(IPC.readDrawing, id),
  writeDrawing: (id, scene) => ipcRenderer.invoke(IPC.writeDrawing, id, scene),
  writeDrawingSvg: (id, svg) =>
    ipcRenderer.invoke(IPC.writeDrawingSvg, id, svg),

  writeNoteFile: (fileName, bytes) =>
    ipcRenderer.invoke(IPC.writeNoteFile, fileName, bytes),

  terminalCreate: (folderId, cols, rows, shellId) =>
    ipcRenderer.invoke(IPC.terminalCreate, folderId, cols, rows, shellId),
  terminalShells: () => ipcRenderer.invoke(IPC.terminalShells),
  terminalWrite: (terminalId, data) =>
    ipcRenderer.invoke(IPC.terminalWrite, terminalId, data),
  terminalResize: (terminalId, cols, rows) =>
    ipcRenderer.invoke(IPC.terminalResize, terminalId, cols, rows),
  terminalKill: (terminalId) =>
    ipcRenderer.invoke(IPC.terminalKill, terminalId),
  terminalCwd: (terminalId) => ipcRenderer.invoke(IPC.terminalCwd, terminalId),

  onTerminalData: (listener) =>
    subscribe<TerminalOutput>(IPC.terminalData, listener),
  onTerminalExit: (listener) =>
    subscribe<TerminalExit>(IPC.terminalExit, listener),

  systemUsage: () => ipcRenderer.invoke(IPC.systemUsage),

  checkForUpdate: () => ipcRenderer.invoke(IPC.checkForUpdate),
  installUpdate: (version) => ipcRenderer.invoke(IPC.installUpdate, version),
  onUpdateProgress: (listener) =>
    subscribe<UpdateProgress>(IPC.updateProgress, listener),

  listPlugins: () => ipcRenderer.invoke(IPC.listPlugins),
  readPluginData: (id) => ipcRenderer.invoke(IPC.readPluginData, id),
  writePluginData: (id, data) =>
    ipcRenderer.invoke(IPC.writePluginData, id, data),
  installPlugin: (source) => ipcRenderer.invoke(IPC.installPlugin, source),
  removePlugin: (id) => ipcRenderer.invoke(IPC.removePlugin, id),
}

contextBridge.exposeInMainWorld("desktop", api)
