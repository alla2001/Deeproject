import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { create } from 'zustand'

export type MenuItem =
  | { separator: true }
  | { label: string; onClick: () => void; danger?: boolean; disabled?: boolean; hint?: string }

interface MenuStore {
  items: MenuItem[] | null
  x: number
  y: number
  open(e: { clientX: number; clientY: number; preventDefault(): void }, items: MenuItem[]): void
  close(): void
}

export const useMenu = create<MenuStore>((set) => ({
  items: null,
  x: 0,
  y: 0,
  open(e, items) {
    e.preventDefault()
    set({ items, x: e.clientX, y: e.clientY })
  },
  close() {
    set({ items: null })
  }
}))

export function ContextMenuHost(): JSX.Element | null {
  const { items, x, y, close } = useMenu()
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })

  useLayoutEffect(() => {
    if (!items) return
    setPos({ x, y })
    const el = ref.current
    if (!el) return
    // Keep the menu inside the window.
    const rect = el.getBoundingClientRect()
    const nx = Math.min(x, window.innerWidth - rect.width - 8)
    const ny = Math.min(y, window.innerHeight - rect.height - 8)
    setPos({ x: Math.max(4, nx), y: Math.max(4, ny) })
  }, [items, x, y])

  useEffect(() => {
    if (!items) return
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', close)
    }
  }, [items, close])

  if (!items) return null

  return (
    <div className="ctx-menu" ref={ref} style={{ left: pos.x, top: pos.y }}>
      {items.map((item, i) =>
        'separator' in item ? (
          <div key={i} className="ctx-sep" />
        ) : (
          <button
            key={i}
            className={`ctx-item${item.danger ? ' ctx-item--danger' : ''}`}
            disabled={item.disabled}
            onClick={() => {
              close()
              item.onClick()
            }}
          >
            <span>{item.label}</span>
            {item.hint && <span className="ctx-hint">{item.hint}</span>}
          </button>
        )
      )}
    </div>
  )
}
