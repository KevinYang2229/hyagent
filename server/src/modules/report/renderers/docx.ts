/**
 * DOCX renderer：ReportDoc → Word 文件。
 *
 * 圖表畫成**資料表**而不是嵌入圖片：一份 Word 檔的用途是繼續編輯與重組，
 * 可編輯的精確表格比一張不能動的點陣圖有用，使用者要視覺化還能自己插入原生 Word 圖表。
 * 這也沿用了 markdown renderer 早就採取的作法——要看圖，pdf 與 html 兩種格式都在。
 *
 * 內文是 LLM 產生的 Markdown，這裡走訪 markdown-it 的 token 流轉成 docx 元素，
 * 而不是自己寫一套 Markdown 解析：同一份內文在三種格式裡必須是同一個解析結果，
 * 各寫一套遲早會在強調、清單巢狀或表格上分歧。
 */
import {
  AlignmentType,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import MarkdownIt from 'markdown-it';
import {
  chartCaptionText,
  chartItemHeader,
  chartValueHeader,
  degradedNoticeText,
  dedupeSources,
  emptySectionText,
  exactChartCaptionText,
  formatReportTimestamp,
  normalizeSectionBody,
  safeUrl,
  sourcesHeading,
} from '../report.strings';
import type { ReportDoc, ReportSection, SectionChart } from '../report.types';

const markdown = new MarkdownIt({ html: false, linkify: false, breaks: false });

type Token = ReturnType<InstanceType<typeof MarkdownIt>['parse']>[number];
type Block = Paragraph | Table;

/** 連結的視覺樣式自己給：不倚賴樣板裡是否存在 Hyperlink 樣式 */
const LINK_COLOR = '0B6BCB';

interface InlineStyle {
  bold?: boolean;
  italics?: boolean;
  code?: boolean;
  link?: boolean;
}

function runOf(text: string, style: InlineStyle): TextRun {
  return new TextRun({
    text,
    ...(style.bold ? { bold: true } : {}),
    ...(style.italics ? { italics: true } : {}),
    ...(style.code ? { font: 'Consolas' } : {}),
    ...(style.link ? { color: LINK_COLOR, underline: {} } : {}),
  });
}

/**
 * 行內 token → docx run。
 *
 * 連結要包成 ExternalHyperlink，所以遇到 link_open 之後的 run 先收在暫存區，
 * 等 link_close 才成組送出；連結無效（safeUrl 擋掉 javascript: 之類）時只留文字，
 * 不能因為網址不安全就把整段字吞掉。
 */
function inlineRuns(children: Token[], base: InlineStyle = {}): (TextRun | ExternalHyperlink)[] {
  const out: (TextRun | ExternalHyperlink)[] = [];
  const style: InlineStyle = { ...base };
  let href: string | undefined;
  let buffered: TextRun[] = [];

  const push = (text: string, extra?: InlineStyle): void => {
    if (text === '') return;
    const run = runOf(text, { ...style, ...extra, ...(href ? { link: true } : {}) });
    if (href) buffered.push(run);
    else out.push(run);
  };

  for (const token of children) {
    switch (token.type) {
      case 'text': push(token.content); break;
      case 'code_inline': push(token.content, { code: true }); break;
      case 'strong_open': style.bold = true; break;
      case 'strong_close': style.bold = false; break;
      case 'em_open': style.italics = true; break;
      case 'em_close': style.italics = false; break;
      case 'softbreak': push(' '); break;
      case 'hardbreak': out.push(new TextRun({ text: '', break: 1 })); break;
      case 'link_open': {
        const raw = token.attrGet('href');
        href = safeUrl(raw === null || raw === undefined ? undefined : String(raw));
        buffered = [];
        break;
      }
      case 'link_close':
        if (href) out.push(new ExternalHyperlink({ children: buffered, link: href }));
        else out.push(...buffered);
        href = undefined;
        buffered = [];
        break;
      default: break;
    }
  }
  // 未閉合的連結（內文被截斷時會發生）：文字照樣要留下
  out.push(...buffered);
  return out;
}

const HEADINGS: Record<string, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  h1: HeadingLevel.HEADING_1,
  h2: HeadingLevel.HEADING_2,
  h3: HeadingLevel.HEADING_3,
  h4: HeadingLevel.HEADING_4,
  h5: HeadingLevel.HEADING_5,
  h6: HeadingLevel.HEADING_6,
};

/** 走訪 markdown-it 的 block token，攤平成 docx 的段落與表格 */
function markdownBlocks(source: string): Block[] {
  const tokens = markdown.parse(source, {});
  const out: Block[] = [];
  const lists: ('bullet' | 'ordered')[] = [];
  let quoted = 0;
  let i = 0;

  const listProps = (): Record<string, unknown> => {
    const level = lists.length - 1;
    if (level < 0) return {};
    return lists[level] === 'ordered'
      ? { numbering: { reference: 'report-ordered', level: Math.min(level, 2) } }
      : { bullet: { level: Math.min(level, 2) } };
  };
  const quoteProps = (): Record<string, unknown> =>
    quoted > 0 ? { indent: { left: 400 * quoted }, style: undefined } : {};

  while (i < tokens.length) {
    const token = tokens[i];
    switch (token.type) {
      case 'heading_open': {
        const inline = tokens[i + 1];
        out.push(new Paragraph({
          heading: HEADINGS[token.tag] ?? HeadingLevel.HEADING_4,
          children: inlineRuns(inline?.children ?? []),
        }));
        i += 3;
        continue;
      }
      case 'paragraph_open': {
        const inline = tokens[i + 1];
        out.push(new Paragraph({
          children: inlineRuns(inline?.children ?? []),
          ...listProps(),
          ...quoteProps(),
        }));
        i += 3;
        continue;
      }
      case 'fence':
      case 'code_block': {
        // 程式碼區塊逐行成段：docx 沒有 <pre>，換行得自己拆
        for (const line of token.content.replace(/\n$/, '').split('\n')) {
          out.push(new Paragraph({ children: [runOf(line || ' ', { code: true })] }));
        }
        i += 1;
        continue;
      }
      case 'bullet_list_open': lists.push('bullet'); i += 1; continue;
      case 'ordered_list_open': lists.push('ordered'); i += 1; continue;
      case 'bullet_list_close':
      case 'ordered_list_close': lists.pop(); i += 1; continue;
      case 'blockquote_open': quoted += 1; i += 1; continue;
      case 'blockquote_close': quoted -= 1; i += 1; continue;
      case 'table_open': {
        const end = tokens.findIndex((t, k) => k > i && t.type === 'table_close');
        out.push(tableOf(tokens.slice(i, end)));
        i = end + 1;
        continue;
      }
      default:
        i += 1;
    }
  }
  return out;
}

/** markdown 表格 token → docx 表格 */
function tableOf(tokens: Token[]): Table {
  const rows: TableRow[] = [];
  let cells: TableCell[] = [];
  let header = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type === 'thead_open') header = true;
    else if (token.type === 'thead_close') header = false;
    else if (token.type === 'tr_open') cells = [];
    else if (token.type === 'tr_close') rows.push(new TableRow({ children: cells, tableHeader: header }));
    else if (token.type === 'th_open' || token.type === 'td_open') {
      const inline = tokens[i + 1];
      cells.push(new TableCell({
        children: [new Paragraph({ children: inlineRuns(inline?.children ?? [], header ? { bold: true } : {}) })],
      }));
      i += 2;
    }
  }
  return new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } });
}

/** 圖表 → 標題 + 資料表 + 出處說明。數字原樣寫入，讀者要核對或再計算都可以 */
function chartBlocks(section: ReportSection, chart: SectionChart, locale: string): Block[] {
  const caption = chart.complete
    ? exactChartCaptionText(locale, chart)
    : chartCaptionText(locale, chart.points.length, section.hits);
  const grouped = chart.kind === 'grouped' && chart.series?.length;
  const valueCols = grouped ? (chart.series as string[]) : [chart.unit?.trim() || chartValueHeader(locale)];

  const head = new TableRow({
    tableHeader: true,
    children: [chartItemHeader(locale), ...valueCols].map(
      (text) => new TableCell({ children: [new Paragraph({ children: [runOf(text, { bold: true })] })] }),
    ),
  });
  const body = chart.points.map((point) => {
    const values = grouped ? (point.values ?? [point.value]) : [point.value];
    return new TableRow({
      children: [point.label, ...values.map((v) => v.toLocaleString('en-US'))].map(
        (text, col) => new TableCell({
          children: [new Paragraph({
            children: [runOf(text, {})],
            ...(col > 0 ? { alignment: AlignmentType.RIGHT } : {}),
          })],
        }),
      ),
    });
  });

  return [
    new Paragraph({ children: [runOf(chart.title, { bold: true })] }),
    new Table({ rows: [head, ...body], width: { size: 100, type: WidthType.PERCENTAGE } }),
    new Paragraph({ children: [runOf(caption, { italics: true })] }),
  ];
}

function sectionBlocks(section: ReportSection, locale: string): Block[] {
  const out: Block[] = [new Paragraph({ heading: HeadingLevel.HEADING_2, text: section.heading })];
  if (section.degraded) {
    out.push(new Paragraph({ children: [runOf(degradedNoticeText(locale), { italics: true })] }));
  }
  if (section.hits === 0) {
    out.push(new Paragraph({ children: [runOf(emptySectionText(locale), { italics: true })] }));
    return out;
  }
  out.push(...markdownBlocks(normalizeSectionBody(section.body, section.heading)));
  for (const chart of section.charts ?? []) out.push(...chartBlocks(section, chart, locale));
  return out;
}

export async function renderDocx(doc: ReportDoc): Promise<Buffer> {
  const children: Block[] = [
    new Paragraph({ heading: HeadingLevel.TITLE, text: doc.title }),
    new Paragraph({
      children: [runOf(`${doc.topic} · ${formatReportTimestamp(doc.generatedAt)}`, { italics: true })],
    }),
  ];
  for (const section of doc.sections) children.push(...sectionBlocks(section, doc.locale));

  const sources = dedupeSources(doc.sections);
  if (sources.length > 0) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, text: sourcesHeading(doc.locale) }));
    for (const source of sources) {
      const url = safeUrl(source.url);
      children.push(new Paragraph({
        bullet: { level: 0 },
        children: url
          ? [new ExternalHyperlink({ children: [runOf(source.title, { link: true })], link: url })]
          : [runOf(source.title, {})],
      }));
    }
  }

  const file = new Document({
    numbering: {
      config: [{
        reference: 'report-ordered',
        levels: [0, 1, 2].map((level) => ({
          level,
          format: 'decimal' as const,
          text: `%${level + 1}.`,
          alignment: AlignmentType.START,
        })),
      }],
    },
    // 頁邊界對齊 html renderer 的 @page（16mm 上下、14mm 左右）；1mm ≈ 56.7 twip
    sections: [{
      properties: { page: { margin: { top: 907, bottom: 907, left: 794, right: 794 } } },
      children,
    }],
  });
  return Packer.toBuffer(file);
}

export const docxRenderer = {
  format: 'docx',
  contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  render: renderDocx,
};
