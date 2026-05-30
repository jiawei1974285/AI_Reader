type HelpCard = {
  title: string;
  summary: string;
  steps: string[];
  tip: string;
};

const HELP_CARDS: HelpCard[] = [
  {
    title: "导入与书架",
    summary: "先把本地书库接进来，再用搜索、分类和推荐快速找到要读的书。",
    steps: [
      "点击「换目录」选择包含电子书的文件夹，AIreader 会扫描 EPUB、TXT、PDF、DOCX、MOBI、AZW、AZW3。",
      "也可以直接把电子书文件拖进书架，应用会复制到当前书库目录并刷新书架。",
      "新增或删除文件后，点击「重新扫描」立即刷新书架；应用也会监听书库目录变化。",
      "用顶部搜索框、分类 chip 和排序菜单继续缩小范围。",
      "点「推荐」查看基于阅读历史、分类和内容相似度生成的推荐书单。",
    ],
    tip: "第一次使用时，建议先选书库，再等封面和分类慢慢补齐。",
  },
  {
    title: "阅读操作",
    summary: "打开一本书后，可以续读、跳目录、翻页滚动，并随时调整阅读外观。",
    steps: [
      "在书架点击书卡进入阅读页，应用会自动恢复上次阅读的章节和滚动位置。",
      "点「目录」在章节之间跳转；PDF 会按页码阅读，其他格式按章节阅读。",
      "用鼠标滚轮或触控板滚动阅读，阅读进度会自动保存。",
      "点「阅读设置」调整字号、字体、行距、主题、段落缩进和阅读宽度。",
    ],
    tip: "读到重要位置时点「书签」，以后可从书架顶部的书签抽屉直接回到那一处。",
  },
  {
    title: "标注与笔记",
    summary: "选中文字后可以做颜色标注、补充注释，并在统一面板里回看或导出。",
    steps: [
      "在正文里拖选一段文字，弹出的标注工具会显示颜色选项。",
      "选择颜色后，标注会保存到本地数据库，并在原文位置高亮显示。",
      "打开「笔记」或「标注」入口，可以按书查看所有高亮和注释。",
      "需要整理资料时，使用导出功能把标注内容带出到外部文档。",
    ],
    tip: "建议用不同颜色区分观点、人物、地点和待追问内容，后续问 AI 时更好整理。",
  },
  {
    title: "AI 问答",
    summary: "你可以围绕当前章节、整本书或全书库提问，也可以把回答保存成 AI 笔记。",
    steps: [
      "先在「AI 设置」里配置自己的 LLM 网关和模型。",
      "阅读时打开「问 AI」，选择当前章节、整本书或全书库作为问题范围。",
      "输入问题后，AIreader 会带上对应上下文，返回更贴近原文的回答。",
      "遇到有价值的回答，点击保存为 AI 笔记，之后可在笔记列表里回看。",
    ],
    tip: "适合问人物关系、章节总结、概念解释、伏笔线索和跨书库主题检索。",
  },
  {
    title: "实体提取",
    summary: "让 AIreader 提取人物、地名等实体，并在正文里用下划线辅助理解。",
    steps: [
      "打开一本书后，使用实体提取功能分析当前内容。",
      "提取完成后，人物、地名等实体会在正文中以下划线提示。",
      "点击带下划线的词，可以查看实体解释或上下文说明。",
      "如果内容较长，建议按章节逐步提取，结果更容易检查。",
    ],
    tip: "读小说、历史、传记和设定复杂的书时，这个功能最有用。",
  },
  {
    title: "AI 配乐",
    summary: "根据章节情绪推荐本地音乐，让阅读氛围和内容更贴合。",
    steps: [
      "先设置音乐目录，让 AIreader 建立本地音乐索引。",
      "阅读章节时打开配乐入口，应用会分析当前章节的情绪标签。",
      "系统会从本地音乐里推荐匹配的曲目，并尽量避开不合适的氛围。",
      "如果推荐不准，可以换章节或刷新音乐索引后再试。",
    ],
    tip: "配乐只使用你的本地音乐文件；NCM 解密缓存也保存在本机。",
  },
];

const FIRST_RUN_STEPS = [
  "导入书库",
  "打开一本书",
  "选中文字做标注",
  "打开问 AI",
  "提取实体",
];

type Props = {
  onClose: () => void;
};

export function HelpPanel({ onClose }: Props) {
  return (
    <div className="absolute inset-0 z-40 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-[var(--color-ink)]/10 backdrop-blur-[2px]" />
      <aside
        onClick={(e) => e.stopPropagation()}
        className="studio-drawer relative h-full w-[31rem] max-w-[94vw] overflow-auto"
      >
        <div className="px-6 py-5 border-b border-[var(--color-paper-edge)] flex items-start justify-between gap-3">
          <div>
            <h3 className="studio-title text-lg">使用帮助</h3>
            <p className="text-xs studio-subtle mt-1 leading-5">
              从导入书库到阅读、标注、问 AI 和配乐，这里按常用流程给你一份快速上手说明。
            </p>
          </div>
          <button onClick={onClose} className="studio-icon-button" aria-label="关闭使用帮助">
            x
          </button>
        </div>

        <div className="px-6 py-5 space-y-4 text-sm text-[var(--color-ink)]">
          {HELP_CARDS.map((card) => (
            <section
              key={card.title}
              className="rounded-md border border-[var(--color-paper-edge)] bg-[var(--color-paper)]/60 px-4 py-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h4 className="studio-title text-base leading-tight">{card.title}</h4>
                  <p className="mt-1 text-xs leading-5 text-[var(--color-ink-soft)]">
                    {card.summary}
                  </p>
                </div>
              </div>

              <ol className="mt-3 space-y-2">
                {card.steps.map((step, idx) => (
                  <li key={step} className="flex gap-2 leading-5">
                    <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-[var(--color-paper-edge)] bg-[var(--color-paper-soft)] text-[11px] text-[var(--color-ink-soft)]">
                      {idx + 1}
                    </span>
                    <span>{step}</span>
                  </li>
                ))}
              </ol>

              <p className="mt-3 rounded border border-[var(--color-paper-edge)] bg-[var(--color-paper-soft)] px-3 py-2 text-xs leading-5 text-[var(--color-ink-soft)]">
                {card.tip}
              </p>
            </section>
          ))}

          <section className="rounded-md border border-[var(--color-accent)]/30 bg-[var(--color-paper)]/75 px-4 py-4">
            <h4 className="studio-title text-base leading-tight">首次使用建议流程</h4>
            <p className="mt-1 text-xs leading-5 text-[var(--color-ink-soft)]">
              如果你刚开始用，按这个顺序走一遍，能最快理解 AIreader 的核心能力。
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
              {FIRST_RUN_STEPS.map((step, idx) => (
                <span key={step} className="inline-flex items-center gap-2">
                  <span className="rounded border border-[var(--color-paper-edge)] bg-[var(--color-paper-soft)] px-2 py-1 text-[var(--color-ink-soft)]">
                    {step}
                  </span>
                  {idx < FIRST_RUN_STEPS.length - 1 && (
                    <span className="studio-subtle">→</span>
                  )}
                </span>
              ))}
            </div>
          </section>
        </div>
      </aside>
    </div>
  );
}
