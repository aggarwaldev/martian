import * as md from '../markdown';
import * as notion from '../notion';
import {ParserOptions} from '..';
import path from 'path';
import {URL} from 'url';

function ensureLength(text: string, copy?: object) {
  const chunks = text.match(/[^]{1,2000}/g) || [];
  return chunks.flatMap((item: string) => notion.richText(item, copy));
}

function parseInline(
  element: md.PhrasingContent,
  options?: notion.RichTextOptions
): notion.RichText[] {
  const copy = {
    annotations: {
      ...(options?.annotations ?? {}),
    },
    url: options?.url,
  };

  switch (element.type) {
    case 'text':
      return ensureLength(element.value, copy);

    case 'delete':
      copy.annotations.strikethrough = true;
      return element.children.flatMap(child => parseInline(child, copy));

    case 'emphasis':
      copy.annotations.italic = true;
      return element.children.flatMap(child => parseInline(child, copy));

    case 'strong':
      copy.annotations.bold = true;
      return element.children.flatMap(child => parseInline(child, copy));

    case 'link':
      copy.url = element.url;
      return element.children.flatMap(child => parseInline(child, copy));

    case 'inlineCode':
      copy.annotations.code = true;
      return [notion.richText(element.value, copy)];

    default:
      return [];
  }
}

function parseImage(image: md.Image, options: ParserOptions): notion.Block {
  // https://developers.notion.com/reference/block#image-blocks
  const allowedTypes = [
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.tif',
    '.tiff',
    '.bmp',
    '.svg',
    '.heic',
  ];

  function dealWithError() {
    return notion.paragraph([notion.richText(image.url, {url: image.url})]);
  }

  try {
    if (options.strictImageUrls) {
      const parsedUrl = new URL(image.url);
      const fileType = path.extname(parsedUrl.pathname);
      if (allowedTypes.includes(fileType)) {
        return notion.image(image.url);
      } else {
        return dealWithError();
      }
    } else {
      return notion.image(image.url);
    }
  } catch (error: unknown) {
    return dealWithError();
  }
}

function parseParagraph(
  element: md.Paragraph,
  options: ParserOptions
): notion.Block[] {
  // Paragraphs can also be legacy 'TOC' from some markdown, so we check first
  const mightBeToc =
    element.children.length > 2 &&
    element.children[0].type === 'text' &&
    element.children[0].value === '[[' &&
    element.children[1].type === 'emphasis';
  if (mightBeToc) {
    const emphasisItem = element.children[1] as md.Emphasis;
    const emphasisTextItem = emphasisItem.children[0] as md.Text;
    if (emphasisTextItem.value === 'TOC') {
      return [notion.table_of_contents()];
    }
  }

  // Notion doesn't deal with inline images, so we need to parse them all out
  // of the paragraph into individual blocks
  const images: notion.Block[] = [];
  const paragraphs: Array<notion.RichText[]> = [];
  element.children.forEach(item => {
    if (item.type === 'image') {
      images.push(parseImage(item, options));
    } else {
      const richText = parseInline(item) as notion.RichText[];
      if (richText.length) {
        paragraphs.push(richText);
      }
    }
  });

  if (paragraphs.length) {
    return [notion.paragraph(paragraphs.flat()), ...images];
  } else {
    return images;
  }
}

function parseBlockquote(
  element: md.Blockquote,
  options: ParserOptions
): notion.Block {
  // Quotes can only contain RichText[], but come through as Block[]
  // This code collects and flattens the common ones
  const blocks = element.children.flatMap(child => parseNode(child, options));
  const paragraphs = blocks.flatMap(child => child as notion.Block);
  const richtext = paragraphs.flatMap(child => {
    if (child.paragraph) {
      return child.paragraph.text as notion.RichText[];
    }
    if (child.heading_1) {
      return child.heading_1.text as notion.RichText[];
    }
    if (child.heading_2) {
      return child.heading_2.text as notion.RichText[];
    }
    if (child.heading_3) {
      return child.heading_3.text as notion.RichText[];
    }
    return [];
  });
  return notion.blockquote(richtext as notion.RichText[]);
}

function parseHeading(element: md.Heading): notion.Block {
  const text = element.children.flatMap(child => parseInline(child));

  switch (element.depth) {
    case 1:
      return notion.headingOne(text);

    case 2:
      return notion.headingTwo(text);

    default:
      return notion.headingThree(text);
  }
}

function parseCode(element: md.Code): notion.Block {
  const text = ensureLength(element.value);
  return notion.code(text);
}

function parseList(element: md.List, options: ParserOptions): notion.Block[] {
  return element.children.flatMap(item => {
    const paragraph = item.children.shift();
    if (paragraph === undefined || paragraph.type !== 'paragraph') {
      return [] as notion.Block[];
    }

    const text = paragraph.children.flatMap(child => parseInline(child));

    // Now process any of the children
    const parsedChildren: notion.Block[] = item.children.flatMap(child =>
      parseNode(child, options)
    );

    if (element.start !== null && element.start !== undefined) {
      return [notion.numberedListItem(text, parsedChildren)];
    } else if (item.checked !== null && item.checked !== undefined) {
      return [notion.toDo(item.checked, text, parsedChildren)];
    } else {
      return [notion.bulletedListItem(text, parsedChildren)];
    }
  });
}

function parseTableCell(node: md.TableCell): notion.Block[] {
  const text = node.children.flatMap(child => parseInline(child));
  return [notion.tableCell(text)];
}

function parseTableRow(node: md.TableRow): notion.Block[] {
  const tableCells = node.children.flatMap(child => parseTableCell(child));
  return [notion.tableRow(tableCells)];
}

function parseTable(node: md.Table): notion.Block[] {
  const tableRows = node.children.flatMap(child => parseTableRow(child));
  return [notion.table(tableRows)];
}

function parseNode(
  node: md.FlowContent,
  options: ParserOptions
): notion.Block[] {
  switch (node.type) {
    case 'heading':
      return [parseHeading(node)];

    case 'paragraph':
      return parseParagraph(node, options);

    case 'code':
      return [parseCode(node)];

    case 'blockquote':
      return [parseBlockquote(node, options)];

    case 'list':
      return parseList(node, options);

    case 'table':
      if (options.allowUnsupportedObjectType) {
        return parseTable(node);
      } else {
        return [];
      }

    default:
      return [];
  }
}

export function parseBlocks(
  root: md.Root,
  options: ParserOptions
): notion.Block[] {
  return root.children.flatMap(item => parseNode(item, options));
}

export function parseRichText(root: md.Root): notion.RichText[] {
  if (root.children[0].type !== 'paragraph') {
    throw new Error(`Unsupported markdown element: ${JSON.stringify(root)}`);
  }

  const richTexts: notion.RichText[] = [];
  root.children.forEach(paragraph => {
    if (paragraph.type === 'paragraph') {
      paragraph.children.forEach(child =>
        richTexts.push(...parseInline(child))
      );
    }
  });
  return richTexts;
}
