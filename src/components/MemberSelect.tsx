import { useEffect, useMemo, useRef, useState } from 'react';
import { createAvatar } from '@dicebear/core';
import { thumbs } from '@dicebear/collection';
import type { Member } from '../types';

interface MemberSelectProps {
  members: Member[];
  /** Selected member id, or '' for none. */
  value: string;
  onChange: (memberId: string) => void;
  placeholder: string;
  /** Hide this member from the options (e.g. the sender in a "To" list). */
  excludeId?: string;
}

function avatarUrl(m: Member): string {
  const svg = createAvatar(thumbs, { seed: m.avatarSeed || m.name, size: 32 }).toString();
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

// Dropdown member picker with profile avatars — native <select> can't render
// images. Same interaction pattern as the bank picker in ProfileModal.
export function MemberSelect({ members, value, onChange, placeholder, excludeId }: MemberSelectProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const options = useMemo(
    () => members.filter((m) => !m.removedAt && m.id !== excludeId),
    [members, excludeId],
  );
  const selected = members.find((m) => m.id === value);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="cursor-pointer w-full flex items-center gap-3 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-left focus:outline-none focus:ring-2 focus:ring-cyan-500"
      >
        {selected ? (
          <>
            <img src={avatarUrl(selected)} alt="" className="w-7 h-7 rounded-full bg-gray-700 shrink-0" />
            <span className="flex-1 text-gray-100 truncate">{selected.name}</span>
          </>
        ) : (
          <span className="flex-1 text-gray-400">{placeholder}</span>
        )}
        <svg className="w-4 h-4 text-gray-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="absolute z-20 mt-1 w-full max-h-56 overflow-y-auto bg-gray-800 border border-gray-600 rounded-lg shadow-xl">
          {options.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => {
                onChange(m.id);
                setOpen(false);
              }}
              className={`cursor-pointer w-full flex items-center gap-3 px-3 py-2 hover:bg-gray-700 text-left ${
                m.id === value ? 'bg-gray-700/60' : ''
              }`}
            >
              <img src={avatarUrl(m)} alt="" className="w-7 h-7 rounded-full bg-gray-700 shrink-0" />
              <span className="text-gray-100 text-sm truncate">{m.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
