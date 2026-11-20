import { randomUUID } from "node:crypto";

/** Internal links are keyed by real character id, even when a handle changes. */
export interface BoardLink {
  id: string;
  a: string;
  b: string;
  label: string;
}

export class PlayerBoardError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400
  ) {
    super(message);
  }
}

export function linksTouching(links: BoardLink[], realId: string): BoardLink[] {
  return links.filter((link) => link.a === realId || link.b === realId);
}

export function findLink(
  links: BoardLink[],
  a: string,
  b: string,
  label: string
): BoardLink | undefined {
  return linksTouching(links, a).find(
    (link) => link.label === label && (link.a === b || link.b === b)
  );
}

export function addLink(
  links: BoardLink[],
  a: string,
  b: string,
  label: string
): BoardLink[] {
  if (a === b) throw new PlayerBoardError("choose two different people");
  const name = label.trim();
  if (!name) throw new PlayerBoardError("empty link label");
  if (findLink(links, a, b, name)) return links;
  return [...links, { id: randomUUID(), a, b, label: name }];
}

export function removeLink(links: BoardLink[], id: string): BoardLink[] {
  if (!links.some((link) => link.id === id)) return links;
  return links.filter((link) => link.id !== id);
}
