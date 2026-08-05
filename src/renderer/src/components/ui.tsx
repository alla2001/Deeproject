import { useEffect, type ReactNode } from 'react'
import { EMOJI_CHOICES, PALETTE } from '@shared/defaults'

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide
}: {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <div className="modal-scrim" onMouseDown={onClose}>
      <div
        className={`modal${wide ? ' modal--wide' : ''}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} title="Close (Esc)">
            ✕
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  )
}

export function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: ReactNode
}): JSX.Element {
  return (
    <label className="field">
      <span className="field-label">
        {label}
        {hint && <span className="field-hint">{hint}</span>}
      </span>
      {children}
    </label>
  )
}

export function ColorPicker({
  value,
  onChange
}: {
  value: string
  onChange: (v: string) => void
}): JSX.Element {
  return (
    <div className="color-picker">
      {PALETTE.map((c) => (
        <button
          key={c}
          className={`swatch${c.toLowerCase() === value.toLowerCase() ? ' swatch--on' : ''}`}
          style={{ background: c }}
          title={c}
          onClick={() => onChange(c)}
        />
      ))}
      <input
        type="color"
        className="swatch swatch--custom"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        title="Custom colour"
      />
    </div>
  )
}

export function EmojiPicker({
  value,
  onChange
}: {
  value: string
  onChange: (v: string) => void
}): JSX.Element {
  return (
    <div className="emoji-picker">
      <input
        className="emoji-input"
        value={value}
        maxLength={4}
        onChange={(e) => onChange(e.target.value)}
        title="Type or paste any emoji"
      />
      <div className="emoji-grid">
        {EMOJI_CHOICES.map((e) => (
          <button
            key={e}
            className={`emoji-opt${e === value ? ' emoji-opt--on' : ''}`}
            onClick={() => onChange(e)}
          >
            {e}
          </button>
        ))}
      </div>
    </div>
  )
}

export function BackgroundPicker({
  image,
  opacity,
  blur,
  onChange
}: {
  image: string | null
  opacity: number
  blur: number
  onChange: (patch: {
    backgroundImage?: string | null
    backgroundOpacity?: number
    backgroundBlur?: number
  }) => void
}): JSX.Element {
  return (
    <div className="bg-picker">
      <div className="bg-preview">
        {image ? (
          <img src={window.api.sys.mediaUrl(image)} alt="" style={{ opacity, filter: `blur(${blur}px)` }} />
        ) : (
          <span className="bg-empty">No image</span>
        )}
      </div>
      <div className="bg-controls">
        <div className="row">
          <button
            className="btn"
            onClick={async () => {
              const picked = await window.api.dialog.pickImage()
              if (picked) onChange({ backgroundImage: picked })
            }}
          >
            Choose image…
          </button>
          <button className="btn" disabled={!image} onClick={() => onChange({ backgroundImage: null })}>
            Clear
          </button>
        </div>
        <Field label="Opacity" hint={`${Math.round(opacity * 100)}%`}>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={opacity}
            onChange={(e) => onChange({ backgroundOpacity: Number(e.target.value) })}
          />
        </Field>
        <Field label="Blur" hint={`${blur}px`}>
          <input
            type="range"
            min={0}
            max={20}
            step={1}
            value={blur}
            onChange={(e) => onChange({ backgroundBlur: Number(e.target.value) })}
          />
        </Field>
        {image && <div className="bg-path">{image}</div>}
      </div>
    </div>
  )
}
