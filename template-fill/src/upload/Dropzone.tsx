import { useRef, useState } from 'react';
import { UploadSimple } from '@phosphor-icons/react';

/** Drop files here, or click to choose them. */
export function Dropzone({ accept, multiple = true, disabled, title, hint, onFiles }: {
  accept: string; multiple?: boolean; disabled?: boolean; title: string; hint: string; onFiles: (files: File[]) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const take = (list: FileList | null) => { if (list && list.length) onFiles(multiple ? [...list] : [list[0]]); };
  return (
    <div
      className={`dropzone${over ? ' over' : ''}${disabled ? ' off' : ''}`}
      role="button" tabIndex={disabled ? -1 : 0} aria-disabled={disabled}
      onClick={() => !disabled && input.current?.click()}
      onKeyDown={(e) => { if (!disabled && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); input.current?.click(); } }}
      onDragOver={(e) => { if (disabled) return; e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); if (!disabled) take(e.dataTransfer.files); }}
    >
      <span className="icon-tile"><UploadSimple size={20} /></span>
      <div>
        <div style={{ fontWeight: 500 }}>{title}</div>
        <div className="dim" style={{ fontSize: 13 }}>{hint}</div>
      </div>
      <input ref={input} type="file" hidden accept={accept} multiple={multiple} onChange={(e) => { take(e.target.files); e.target.value = ''; }} />
    </div>
  );
}
