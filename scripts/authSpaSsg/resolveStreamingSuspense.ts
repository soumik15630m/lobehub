import { parseHTML } from 'linkedom';

const isComment = (node: ChildNode | null, value: string) =>
  node?.nodeType === node.COMMENT_NODE && node.nodeValue === value;

export const resolveStreamingSuspense = (html: string) => {
  const { document } = parseHTML(html);
  const pendingBoundaries = Array.from(document.querySelectorAll('template[id^="B:"]'));

  for (const template of pendingBoundaries) {
    const boundaryId = template.id.slice(2);
    const segment = document.getElementById(`S:${boundaryId}`);
    const start = template.previousSibling;
    let end = template.nextSibling;

    while (end && !isComment(end, '/$')) end = end.nextSibling;

    if (!segment || !isComment(start, '$?') || !end) {
      throw new Error(`Incomplete React streaming boundary: ${template.id}`);
    }

    while (template.nextSibling && template.nextSibling !== end) {
      template.nextSibling.remove();
    }

    while (segment.firstChild) end.parentNode?.insertBefore(segment.firstChild, end);

    start.nodeValue = '$';
    template.remove();
    segment.remove();
  }

  for (const script of Array.from(document.querySelectorAll('script'))) {
    const source = script.textContent ?? '';
    if (source.includes('$RC=function') || source.includes('$RT=performance.now()')) {
      script.remove();
    }
  }

  return document.toString();
};
