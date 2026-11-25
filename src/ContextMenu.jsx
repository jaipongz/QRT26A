import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

// items: [{ label, onClick, disabled, danger, shortcut } | '-' ]
export default function ContextMenu({ x, y, items, onClose }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.min(x, window.innerWidth - r.width - 6),
      y: Math.min(y, window.innerHeight - r.height - 6),
    });
  }, [x, y]);

  useEffect(() => {
    const close = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    const key = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', close, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', close, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  return (
    <div className="ctx-menu" ref={ref} style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
      {items.map((it, i) =>
        it === '-' ? (
          <div key={i} className="ctx-sep" />
        ) : (
          <div
            key={i}
            className={'ctx-item' + (it.disabled ? ' disabled' : '') + (it.danger ? ' danger' : '')}
            onClick={() => {
              if (it.disabled) return;
              onClose();
              it.onClick();
            }}
          >
            <span>{it.label}</span>
            {it.shortcut && <span className="ctx-shortcut">{it.shortcut}</span>}
          </div>
        )
      )}
    </div>
  );
}

export function useContextMenu() {
  const [menu, setMenu] = useState(null);
  const open = (e, items) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items });
  };
  const element = menu ? <ContextMenu {...menu} onClose={() => setMenu(null)} /> : null;
  return [open, element];
}
