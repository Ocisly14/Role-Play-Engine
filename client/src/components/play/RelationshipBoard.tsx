import { useState } from "react";
import type { PlayerBoardView } from "../../services/playerApi";
import { formatGameTime } from "./playConstants";

const field = "min-w-0 rounded border border-gray-300 px-2 py-1 text-sm";
const button =
  "rounded bg-slate-700 px-2 py-1 text-sm text-white disabled:opacity-50";

type EditPerson = (handle: string, text: string) => Promise<boolean>;

function PersonCard({
  person,
  disabled,
  onName,
  onNote,
}: {
  person: PlayerBoardView["people"][number];
  disabled: boolean;
  onName: EditPerson;
  onNote: EditPerson;
}) {
  const [name, setName] = useState("");
  const [note, setNote] = useState("");

  return (
    <details className="rounded border border-gray-200 px-2 py-1">
      <summary className="cursor-pointer break-words text-sm">
        {person.label}
      </summary>
      <div className="space-y-2 py-2">
        {person.firstMet && (
          <p className="text-xs text-gray-500">
            初遇于 {formatGameTime(person.firstMet)}
          </p>
        )}
        {person.notes.length > 0 && (
          <ul className="space-y-1 text-sm text-gray-700">
            {person.notes.map((text, index) => (
              <li key={index} className="whitespace-pre-wrap break-words">
                {text}
              </li>
            ))}
          </ul>
        )}
        <form
          className="flex gap-1"
          onSubmit={async (event) => {
            event.preventDefault();
            if (
              !disabled &&
              name.trim() &&
              (await onName(person.handle, name.trim()))
            ) {
              setName("");
            }
          }}
        >
          <input
            aria-label="称呼"
            className={`${field} flex-1`}
            placeholder={person.knownAs ? "新的称呼" : "给对方起个名字"}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <button className={button} disabled={disabled || !name.trim()}>
            命名
          </button>
        </form>
        <form
          className="grid gap-1"
          onSubmit={async (event) => {
            event.preventDefault();
            if (
              !disabled &&
              note.trim() &&
              (await onNote(person.handle, note.trim()))
            ) {
              setNote("");
            }
          }}
        >
          <textarea
            aria-label="备注"
            className={field}
            placeholder="写下你对这个人的印象"
            rows={2}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          <button
            className={`${button} justify-self-start`}
            disabled={disabled || !note.trim()}
          >
            保存备注
          </button>
        </form>
      </div>
    </details>
  );
}

export function RelationshipBoard({
  board,
  disabled,
  onName,
  onNote,
  onLink,
  onUnlink,
}: {
  board: PlayerBoardView;
  disabled: boolean;
  onName: EditPerson;
  onNote: EditPerson;
  onLink: (a: string, b: string, label: string) => Promise<boolean>;
  onUnlink: (id: string) => void;
}) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [label, setLabel] = useState("");
  const people = new Map(
    board.people.map((person) => [person.handle, person.label])
  );
  const a = people.has(from) ? from : "";
  const b = people.has(to) ? to : "";
  const canLink = !disabled && a && b && a !== b && label.trim();

  return (
    <section className="space-y-2 rounded bg-white p-3 shadow">
      <h3 className="text-sm font-semibold text-gray-500">关系板</h3>
      {board.people.length === 0 && (
        <p className="text-sm text-gray-400">遇到的人会出现在这里。</p>
      )}
      {board.people.map((person) => (
        <PersonCard
          key={person.handle}
          person={person}
          disabled={disabled}
          onName={onName}
          onNote={onNote}
        />
      ))}
      {board.links.length > 0 && (
        <ul aria-label="人物连线" className="divide-y text-sm">
          {board.links.map((link) => (
            <li
              key={link.id}
              className="flex items-baseline justify-between gap-2 py-1"
            >
              <span className="min-w-0 break-words">
                {people.get(link.a)} — {link.label} — {people.get(link.b)}
              </span>
              <button
                type="button"
                disabled={disabled}
                className="shrink-0 text-xs text-gray-600 underline disabled:opacity-50"
                onClick={() => onUnlink(link.id)}
              >
                移除
              </button>
            </li>
          ))}
        </ul>
      )}
      {board.people.length >= 2 && (
        <form
          className="grid grid-cols-2 gap-1 border-t pt-2"
          onSubmit={async (event) => {
            event.preventDefault();
            if (canLink && (await onLink(a, b, label.trim()))) setLabel("");
          }}
        >
          <select
            aria-label="连线起点"
            className={field}
            value={a}
            onChange={(event) => setFrom(event.target.value)}
          >
            <option value="">选一个人</option>
            {board.people.map((person) => (
              <option key={person.handle} value={person.handle}>
                {person.label}
              </option>
            ))}
          </select>
          <select
            aria-label="连线终点"
            className={field}
            value={b}
            onChange={(event) => setTo(event.target.value)}
          >
            <option value="">选另一个人</option>
            {board.people.map((person) => (
              <option key={person.handle} value={person.handle}>
                {person.label}
              </option>
            ))}
          </select>
          <input
            aria-label="连线备注"
            className={`${field} col-span-2`}
            placeholder="两人的关系"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
          <button
            className={`${button} col-span-2 justify-self-start`}
            disabled={!canLink}
          >
            添加连线
          </button>
        </form>
      )}
    </section>
  );
}
