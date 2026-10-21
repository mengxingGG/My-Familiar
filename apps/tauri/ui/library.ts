import type { MobileBridge, MobileMemoryDocument, MobileMemoryList, MobileSkill, MobileSnapshot } from '../../../packages/mobile-contracts/index.ts';

type Confirm = { title: string; body: string; confirmLabel: string; action: () => Promise<unknown>; done: string; tone?: 'danger' | 'primary' };
type Draft = MobileMemoryDocument & { original: string; create: boolean; conflict: boolean; latest?: MobileMemoryDocument };
const emptyRevision = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') => { const el = document.createElement(tag); el.textContent = text; el.className = className; return el; };
const button = (text: string, action: () => void, className = 'quiet') => { const el = node('button', text, className); el.type = 'button'; el.addEventListener('click', action); return el; };
const label = (text: string, input: HTMLElement) => { const el = node('label', '', 'field'); el.append(node('span', text, 'field-label'), input); return el; };
const code = (error: unknown) => error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
const reason = (error: unknown) => ({ CONFLICT: '内容已被修改。草稿已保留，请读取最新版本后合并。', LIMIT: '内容超过大小上限，请删减或拆分。', INVALID_DOCUMENT: '技能需要正确的 YAML name、description 和正文。', INVALID_INPUT: '请检查名称、路径和填写的内容。', NOT_FOUND: '这份内容已不存在，请刷新列表。', UNAVAILABLE: '暂时无法完成，请检查连接后再试。', BUSY: '上一项操作尚未结束，请稍后再试。' }[code(error)] ?? '操作尚未确认，请检查当前内容后再试。');

/** 只管理 UI 草稿与导航，不持久化文件，也不执行技能正文。 */
export class LibraryView {
  readonly page = node('section', '', 'page library-page');
  readonly heading = node('h1', '记忆与技能');
  private readonly body = node('div', '', 'page-body library-body');
  private readonly memoryPanel = node('section');
  private readonly skillsPanel = node('section');
  private readonly notice = node('p', '', 'form-status');
  private readonly health = node('p', '', 'block-hint');
  private readonly files = node('div', '', 'library-files');
  private readonly search = node('input');
  private readonly editorPanel = node('section', '', 'panel panel-form library-editor');
  private readonly fileTitle = node('h2', '', 'library-file-title');
  private readonly editor = node('textarea');
  private readonly counter = node('p', '', 'block-hint');
  private readonly savedState = node('p', '', 'form-status');
  private readonly compare = node('details', '', 'library-compare');
  private readonly latestText = node('pre', '', 'library-source');
  private readonly mergeButton: HTMLButtonElement;
  private readonly saveButton: HTMLButtonElement;
  private readonly reloadButton: HTMLButtonElement;
  private readonly skillList = node('div', '', 'library-skills');
  private readonly skillPreview = node('section', '', 'panel panel-form');
  private readonly skillTitle = node('h2', '', 'library-file-title');
  private readonly skillText = node('pre', '', 'library-source');
  private readonly moreSkills: HTMLButtonElement;
  private readonly installContent = node('textarea');
  private readonly installUrl = node('input');
  private readonly installMode = node('select');
  private readonly contentLabel: HTMLLabelElement;
  private readonly urlLabel: HTMLLabelElement;
  private readonly importButton: HTMLButtonElement;
  private readonly installButton: HTMLButtonElement;
  private readonly memoryTab: HTMLButtonElement;
  private readonly skillsTab: HTMLButtonElement;
  private readonly newName = node('input');
  private readonly newLayer = node('select');
  private readonly drafts = new Map<string, Draft>();
  private readonly pending = new Set<string>();
  private activePath = '';
  private selected: 'memory' | 'skills' = 'memory';
  private snapshot?: MobileSnapshot;
  private skills: MobileSkill[] = [];
  private nextSkillOffset: number | null = null;
  private epoch = 0;
  private readId = 0;
  private listId = 0;
  private skillReadId = 0;
  private skillListId = 0;
  private importEdits = 0;
  private opened = false;
  private disposed = false;

  constructor(private readonly bridge: MobileBridge, back: HTMLElement, private readonly confirm: (spec: Confirm) => void, private readonly toast: (message: string, tone?: 'info' | 'error') => void) {
    this.page.hidden = true; this.heading.tabIndex = -1;
    const title = node('div', '', 'pagebar-title'); title.append(this.heading);
    const bar = node('header', '', 'pagebar'); bar.append(back, title);
    this.memoryTab = button('记忆', () => this.select('memory'));
    this.skillsTab = button('技能', () => this.select('skills'));
    const tabs = node('div', '', 'library-tabs'); tabs.append(this.memoryTab, this.skillsTab);
    this.notice.setAttribute('role', 'status'); this.notice.hidden = true;
    this.page.append(bar, this.body); this.body.append(tabs, this.notice, this.memoryPanel, this.skillsPanel);
    this.search.type = 'search'; this.search.maxLength = 200; this.search.placeholder = '关键词或日期'; this.search.setAttribute('aria-label', '搜索记忆');
    const searchForm = node('form', '', 'library-toolbar'); const searchButton = button('搜索', () => void this.loadMemories(true));
    searchForm.append(this.search, searchButton, button('全部', () => { this.search.value = ''; void this.loadMemories(); })); searchForm.addEventListener('submit', e => { e.preventDefault(); void this.loadMemories(true); });
    const create = node('details', '', 'library-create'); create.append(node('summary', '新增记忆'));
    for (const [value, title] of [['topics', '扩展记忆'], ['lessons', '教训'], ['daily', '日记']]) { const option = node('option', title); option.value = value; this.newLayer.append(option); }
    this.newName.maxLength = 80; this.newName.placeholder = '例如：旅行计划';
    create.append(label('记忆分类', this.newLayer), label('文件名称', this.newName), button('开始编辑', () => this.newMemory()));
    this.editor.setAttribute('aria-label', '记忆内容'); this.editor.spellcheck = false; this.editor.rows = 12;
    this.editor.addEventListener('input', () => { const draft = this.current(); if (draft) { draft.text = this.editor.value; this.renderEditorStatus(); } });
    this.saveButton = button('保存记忆', () => void this.saveMemory(), 'primary');
    this.reloadButton = button('读取最新版本', () => void this.loadLatest());
    this.mergeButton = button('保留草稿，开始合并', () => {
      const draft = this.current(); if (!draft?.latest) return;
      draft.revision = draft.latest.revision; draft.original = draft.latest.text; draft.create = false; draft.conflict = false;
      this.savedState.textContent = '草稿已保留。请对照最新版本合并后保存。'; this.renderEditorStatus(false);
    });
    this.compare.append(node('summary', '对照：手机中的最新版本'), this.latestText, this.mergeButton,
      button('采用最新版本', () => {
        const draft = this.current(); if (!draft?.latest) return;
        const latest = draft.latest;
        this.confirm({ title: '采用最新版本', body: `将用 ${draft.path} 的最新版本替换这份未保存草稿。`, confirmLabel: '替换草稿', done: '', action: async () => { this.drafts.set(latest.path, { ...latest, original: latest.text, create: false, conflict: false }); if (this.activePath === latest.path) this.renderEditor(); } });
      }));
    const actions = node('div', '', 'library-editor-actions'); actions.append(this.saveButton, this.reloadButton);
    this.editorPanel.append(this.fileTitle, this.editor, this.counter, this.savedState, this.compare, actions);
    this.editorPanel.hidden = true;
    this.memoryPanel.append(node('p', '核心规则与身份随会话交给模型，扩展记忆按需读取。改动在新会话或下一次上下文刷新后生效。', 'block-hint'), this.health, searchForm, create, this.files, this.editorPanel,
      node('p', '离开此页面会保留草稿，退出应用前请保存。保存前的版本会留作备份。', 'block-hint'));

    this.moreSkills = button('更多技能', () => void this.loadSkills(true)); this.moreSkills.hidden = true;
    this.skillPreview.append(this.skillTitle, this.skillText); this.skillPreview.hidden = true;
    const install = node('section', '', 'panel panel-form library-install'); install.append(node('h2', '安装技能', 'library-file-title'));
    for (const [value, text] of [['content', '粘贴或选择 SKILL.md'], ['url', 'HTTPS 文件地址']]) { const option = node('option', text); option.value = value; this.installMode.append(option); }
    this.installContent.rows = 9; this.installContent.spellcheck = false; this.installContent.placeholder = '---\nname: my-skill\ndescription: 什么时候使用它\n---\n具体步骤';
    this.installUrl.type = 'url'; this.installUrl.placeholder = 'https://…/SKILL.md'; this.installUrl.maxLength = 2000;
    this.contentLabel = label('技能文档', this.installContent); this.urlLabel = label('技能文件地址', this.installUrl); this.urlLabel.hidden = true;
    this.importButton = button('从手机选择 SKILL.md', () => void this.importSkill());
    this.installButton = button('安装技能', () => void this.installSkill(), 'primary');
    this.installMode.addEventListener('change', () => { this.importEdits++; this.renderInstall(); });
    this.installContent.addEventListener('input', () => { this.importEdits++; }); this.installUrl.addEventListener('input', () => { this.importEdits++; });
    install.append(label('安装来源', this.installMode), this.contentLabel, this.urlLabel, this.importButton,
      node('p', '单份文档不超过 64 KB。选择文件只填入编辑框，点击安装才生效；技能说明不授予额外权限。', 'block-hint'), this.installButton);
    this.skillsPanel.append(node('p', '技能告诉伙伴何时、如何处理某类任务。停用后不再提供给新任务；移除会保留文件备份。', 'block-hint'), button('刷新技能', () => void this.loadSkills()), this.skillList, this.moreSkills, this.skillPreview, install);
    this.selectPanel();
  }
  sync(snapshot: MobileSnapshot) { this.snapshot = snapshot; this.memoryTab.hidden = !snapshot.library?.memory; this.skillsTab.hidden = !snapshot.library?.skills; this.renderInstall(); }
  open() { this.opened = true; this.epoch++; if (!this.snapshot?.library?.memory) this.selected = 'skills'; this.selectPanel(); void (this.selected === 'memory' ? this.loadMemories() : this.loadSkills()); }
  close() { this.opened = false; this.epoch++; this.readId++; this.listId++; this.skillReadId++; this.skillListId++; }
  dispose() { this.disposed = true; this.close(); this.drafts.clear(); this.installContent.value = ''; }
  private say(text: string, bad = false) { if (this.disposed) return; this.notice.textContent = text; this.notice.hidden = !text; this.notice.dataset.tone = bad ? 'bad' : 'ok'; }
  private async run<T>(key: string, task: () => Promise<T>): Promise<{ value: T } | undefined> {
    if (this.pending.has(key) || this.disposed) return;
    this.pending.add(key); this.renderEditorStatus(false); this.renderInstall();
    try { return { value: await task() }; } catch (error) { this.say(reason(error), true); throw error; }
    finally { this.pending.delete(key); this.renderEditorStatus(false); this.renderInstall(); }
  }
  private select(which: 'memory' | 'skills') { this.selected = which; this.say(''); this.selectPanel(); void (which === 'memory' ? this.loadMemories() : this.loadSkills()); }
  private selectPanel() { this.memoryPanel.hidden = this.selected !== 'memory'; this.skillsPanel.hidden = this.selected !== 'skills'; this.memoryTab.setAttribute('aria-pressed', String(this.selected === 'memory')); this.skillsTab.setAttribute('aria-pressed', String(this.selected === 'skills')); }
  private current() { return this.drafts.get(this.activePath); }
  private async loadMemories(search = false) {
    const id = ++this.listId, epoch = this.epoch;
    try {
      if (search && !this.search.value.trim()) { this.say('请输入关键词或日期。'); return; }
      const result = search ? await this.bridge.request('library.memory.search', { query: this.search.value.trim() }) : await this.bridge.request('library.memory.list', undefined);
      if (this.disposed || epoch !== this.epoch || id !== this.listId) return;
      const entries = Array.isArray(result) ? result : (result as MobileMemoryList).files.map(path => ({ path, excerpt: '' }));
      if (!Array.isArray(result)) this.health.textContent = `核心规则 ${result.core.characters} / ${result.core.limit} 字 · 索引 ${result.index.characters} / ${result.index.limit} 字${result.index.omitted ? ` · ${result.index.omitted} 个主题未列入索引` : ''}`;
      this.files.replaceChildren();
      for (const [title, match] of [['核心与身份', (p: string) => !p.includes('/')], ['教训', (p: string) => p.startsWith('lessons/')], ['扩展记忆', (p: string) => p.startsWith('topics/')], ['日记', (p: string) => p.startsWith('daily/')], ['其他', (p: string) => p.includes('/') && !/^(lessons|topics|daily)\//.test(p)]] as const) {
        const group = entries.filter(e => match(e.path)); if (!group.length) continue;
        const details = node('details'); details.open = search || title === '核心与身份'; details.append(node('summary', `${title} · ${group.length}`));
        for (const entry of group) { const row = button(entry.path, () => void this.openMemory(entry.path), 'library-file'); if (entry.excerpt) row.append(node('small', entry.excerpt)); details.append(row); }
        this.files.append(details);
      }
      if (!entries.length) this.files.append(node('p', search ? '没有匹配的记忆。' : '还没有记忆文件。', 'block-hint'));
    } catch (error) { if (id === this.listId && epoch === this.epoch) this.say(reason(error), true); }
  }
  private async openMemory(path: string) {
    const id = ++this.readId, epoch = this.epoch;
    if (this.drafts.has(path)) { this.activePath = path; this.renderEditor(); this.editorPanel.scrollIntoView({ block: 'start' }); return; }
    try {
      const value = await this.bridge.request('library.memory.read', { path });
      if (this.disposed || id !== this.readId || epoch !== this.epoch) return;
      this.drafts.set(path, { ...value, original: value.text, create: false, conflict: false }); this.activePath = path; this.renderEditor(); this.editorPanel.scrollIntoView({ block: 'start' });
    } catch (error) { if (id === this.readId && epoch === this.epoch) this.say(reason(error), true); }
  }
  private newMemory() {
    const title = this.newName.value.trim().replace(/\.md$/i, '');
    if (!title || /^[.]/.test(title) || /[\\/\x00-\x1f:]/.test(title) || /[. ]$/.test(title)) { this.say('请填写文件名称，不包含目录或特殊符号。', true); return; }
    const path = `${this.newLayer.value}/${title}.md`;
    if (!this.drafts.has(path)) { const text = `# ${title}\n\n${this.newLayer.value === 'daily' ? '' : '> 何时读：\n\n- '}`; this.drafts.set(path, { path, text, original: '', revision: emptyRevision, characters: 0, truncated: false, create: true, conflict: false }); }
    this.readId++; this.activePath = path; this.renderEditor(); this.editorPanel.scrollIntoView({ block: 'start' }); this.editor.focus();
  }
  private renderEditor() {
    const draft = this.current(); this.editorPanel.hidden = !draft; if (!draft) return;
    this.fileTitle.textContent = draft.path; this.editor.value = draft.text; this.editor.readOnly = draft.truncated;
    this.compare.hidden = !draft.latest; this.latestText.textContent = draft.latest?.text ?? ''; this.mergeButton.disabled = !!draft.latest?.truncated;
    this.renderEditorStatus();
  }
  private renderEditorStatus(updateMessage = true) {
    const draft = this.current(); if (!draft) return;
    const count = Array.from(draft.text).length;
    this.counter.textContent = draft.truncated ? `文件共 ${draft.characters} 字，这里仅预览前 100000 字，不能保存截断版本。` : `${count}${draft.limit ? ` / ${draft.limit}` : ' / 100000'} 字`;
    if (updateMessage) this.savedState.textContent = draft.conflict ? '有新版本，草稿未覆盖。请读取最新版本并合并。' : draft.create || draft.text !== draft.original ? '有未保存的修改' : '已保存版本';
    this.saveButton.disabled = draft.truncated || draft.conflict || this.pending.has('memory-save') || this.pending.has('memory-latest'); this.reloadButton.disabled = this.pending.has('memory-save') || this.pending.has('memory-latest');
  }
  private async saveMemory() {
    const draft = this.current(); if (!draft || draft.truncated || draft.conflict || this.pending.has('memory-latest')) return;
    const text = draft.text;
    try {
      const result = await this.run('memory-save', () => this.bridge.request('library.memory.write', { path: draft.path, text, revision: draft.revision, create: draft.create })); if (!result) return;
      const saved = result.value; const unchanged = draft.text === text;
      Object.assign(draft, saved, { original: saved.text, text: unchanged ? saved.text : draft.text, create: false, conflict: false, latest: undefined });
      if (this.current() === draft) this.renderEditor(); this.toast(saved.redacted ? '记忆已保存，敏感凭据已按规则处理。' : '记忆已保存，新会话或下次上下文刷新后生效。'); if (this.opened) await this.loadMemories();
    } catch (error) { if (code(error) === 'CONFLICT') draft.conflict = true; if (this.current() === draft) this.renderEditorStatus(); }
  }
  private async loadLatest() {
    const draft = this.current(); if (!draft) return;
    try { const result = await this.run('memory-latest', () => this.bridge.request('library.memory.read', { path: draft.path })); if (!result) return;
      if (!draft.create && draft.text === draft.original && !draft.conflict) Object.assign(draft, result.value, { original: result.value.text, latest: undefined });
      else draft.latest = result.value;
      if (this.current() === draft) { this.renderEditor(); if (draft.latest) this.compare.open = true; }
    } catch {}
  }
  private async loadSkills(more = false) {
    if (this.disposed) return;
    const id = ++this.skillListId, epoch = this.epoch;
    this.moreSkills.disabled = true;
    try {
      const result = await this.bridge.request('library.skills.list', { offset: more ? this.nextSkillOffset ?? 0 : 0 });
      if (this.disposed || id !== this.skillListId || epoch !== this.epoch) return;
      this.skills = more ? [...this.skills, ...result.items.filter(s => !this.skills.some(old => old.id === s.id))] : result.items; this.nextSkillOffset = result.nextOffset; this.renderSkills();
    } catch (error) { if (id === this.skillListId && epoch === this.epoch) this.say(reason(error), true); }
    finally { if (id === this.skillListId) this.moreSkills.disabled = false; }
  }
  private renderSkills() {
    this.skillList.replaceChildren(); this.moreSkills.hidden = this.nextSkillOffset === null;
    if (!this.skills.length) this.skillList.append(node('p', '还没有技能。可以在下面安装。', 'block-hint'));
    for (const skill of this.skills) {
      const row = node('article', '', 'panel panel-form library-skill'); row.append(node('h2', skill.id, 'library-file-title'), node('p', !skill.valid ? '文档格式无效' : !skill.supported ? '当前 Android 平台不支持此技能' : skill.enabled ? '已启用' : '已停用', 'block-hint'), node('p', skill.description));
      const actions = node('div', '', 'library-editor-actions');
      const toggle = button(skill.enabled ? '停用' : '启用', () => void this.toggleSkill(skill)); toggle.setAttribute('aria-label', `${skill.enabled ? '停用' : '启用'} ${skill.id}`); toggle.disabled = !skill.valid || !skill.supported;
      actions.append(button('查看', () => void this.readSkill(skill.id)), toggle, button('移除', () => this.confirm({ title: '移除技能', body: `移除 ${skill.id}？技能文件将移入备份，伙伴不再使用它。`, confirmLabel: '移除技能', done: '技能已移入备份', action: async () => { await this.bridge.request('library.skills.remove', { id: skill.id }); if (this.skillTitle.textContent === skill.id) this.skillPreview.hidden = true; await this.loadSkills(); } }), 'quiet danger'));
      row.append(actions); this.skillList.append(row);
    }
  }
  private async toggleSkill(skill: MobileSkill) {
    try { const result = await this.run(`skill-${skill.id}`, () => this.bridge.request('library.skills.toggle', { id: skill.id, enabled: !skill.enabled })); if (result) { this.skillListId++; this.moreSkills.disabled = false; this.skills = this.skills.map(s => s.id === skill.id ? result.value : s); this.renderSkills(); } } catch {}
  }
  private async readSkill(id: string) {
    const request = ++this.skillReadId, epoch = this.epoch;
    try { const result = await this.bridge.request('library.skills.read', { id }); if (request !== this.skillReadId || epoch !== this.epoch || this.disposed) return;
      this.skillTitle.textContent = id; this.skillText.textContent = result.text; this.skillPreview.hidden = false; this.skillPreview.scrollIntoView({ block: 'start' });
    } catch (error) { if (request === this.skillReadId) this.say(reason(error), true); }
  }
  private renderInstall() {
    const url = this.installMode.value === 'url'; this.contentLabel.hidden = url; this.urlLabel.hidden = !url; this.importButton.hidden = url || !this.snapshot?.media?.choose;
    this.installButton.disabled = this.pending.has('skill-install') || this.pending.has('skill-import'); this.importButton.disabled = this.installButton.disabled;
  }
  private async importSkill() {
    const edits = this.importEdits, epoch = this.epoch;
    try {
      const result = await this.run('skill-import', async () => { const files = await this.bridge.request('media.choose', undefined); if (!files.length) return;
        if (files.length !== 1 || files[0].kind !== 'text') throw { code: 'INVALID_DOCUMENT' };
        if (files[0].bytes > 65536) throw { code: 'LIMIT' };
        return this.bridge.request('library.skills.source', { attachmentId: files[0].id });
      });
      if (!result?.value || epoch !== this.epoch || this.disposed) return;
      const text = result.value.text; const fill = async () => { this.installContent.value = text; this.importEdits++; };
      if (edits !== this.importEdits || this.installContent.value) this.confirm({ title: '替换技能草稿', body: '使用刚选择的 SKILL.md 替换当前编辑框内容？这还不会安装技能。', confirmLabel: '替换草稿', done: '', action: fill }); else await fill();
    } catch {}
  }
  private async installSkill() {
    const edits = this.importEdits, url = this.installMode.value === 'url';
    if (!(url ? this.installUrl.value.trim() : this.installContent.value.trim())) { this.say('请先填写技能来源。', true); return; }
    try {
      const result = await this.run('skill-install', () => this.bridge.request('library.skills.install', url ? { url: this.installUrl.value.trim() } : { content: this.installContent.value })); if (!result) return;
      if (edits === this.importEdits) { this.installContent.value = ''; this.installUrl.value = ''; }
      this.toast(`技能 ${result.value.id} 已安装`); await this.loadSkills();
    } catch {}
  }
}
