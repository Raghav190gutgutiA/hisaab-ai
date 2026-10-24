import { useState } from 'react';
import { Check, ChevronDown, ChevronRight, Copy } from 'lucide-react';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function Primitive({ value }: { value: JsonValue }) {
  if (typeof value === 'string') return <span className="text-green-400">"{value}"</span>;
  if (typeof value === 'number') return <span className="text-orange-300">{value}</span>;
  if (typeof value === 'boolean') return <span className="text-purple-400">{String(value)}</span>;
  return <span className="text-zinc-500">null</span>;
}

function Node({
  name,
  value,
  depth,
  isLast,
}: {
  name?: string;
  value: JsonValue;
  depth: number;
  isLast: boolean;
}) {
  const isContainer = value !== null && typeof value === 'object';
  // Top level and its direct children start open; deeper levels collapsed
  const [open, setOpen] = useState(depth < 2);
  const comma = isLast ? '' : ',';
  const label = name !== undefined && <span className="text-sky-300">"{name}"</span>;

  if (!isContainer) {
    return (
      <div style={{ paddingLeft: depth * 16 }}>
        {label}
        {label && ': '}
        <Primitive value={value} />
        {comma}
      </div>
    );
  }

  const entries = Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as const)
    : Object.entries(value);
  const [openBracket, closeBracket] = Array.isArray(value) ? ['[', ']'] : ['{', '}'];
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <div>
      <div style={{ paddingLeft: depth * 16 }} className="flex items-center">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="-ml-4 w-4 text-zinc-500 hover:text-zinc-200">
          <Chevron className="w-3.5 h-3.5" />
        </button>
        <span>
          {label}
          {label && ': '}
          {openBracket}
          {!open && (
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="text-zinc-500 hover:text-zinc-300 px-1">
              … {entries.length} {Array.isArray(value) ? 'items' : 'keys'}
            </button>
          )}
          {!open && `${closeBracket}${comma}`}
        </span>
      </div>
      {open && (
        <>
          {entries.map(([key, child], index) => (
            <Node
              key={key}
              name={Array.isArray(value) ? undefined : key}
              value={child}
              depth={depth + 1}
              isLast={index === entries.length - 1}
            />
          ))}
          <div style={{ paddingLeft: depth * 16 }}>
            {closeBracket}
            {comma}
          </div>
        </>
      )}
    </div>
  );
}

export function JsonViewer({ data }: { data: JsonValue }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="relative rounded-xl border border-zinc-800 bg-zinc-900">
      <button
        type="button"
        onClick={copy}
        className="absolute top-2 right-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs bg-zinc-800 text-zinc-300 hover:bg-zinc-700">
        {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
        {copied ? 'Copied' : 'Copy'}
      </button>
      <div className="p-4 pl-8 font-mono text-xs leading-6 text-zinc-300 overflow-x-auto max-h-[480px] overflow-y-auto">
        <Node value={data} depth={0} isLast />
      </div>
    </div>
  );
}
