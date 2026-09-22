import type { Camera } from './camera'
import type { LabelEntry } from './types'

/**
 * DOM labels for a caller-chosen subset of nodes (hovered, selected, roots…).
 * Positioned each frame from the live positions; cheap for hundreds of labels,
 * and text rendering stays the browser's job.
 */
export class LabelOverlay {
  readonly element: HTMLDivElement
  private entries: LabelEntry[] = []
  private spans: HTMLSpanElement[] = []

  constructor(host: HTMLElement) {
    const el = document.createElement('div')
    el.className = 'edgelit-labels'
    Object.assign(el.style, {
      position: 'absolute',
      inset: '0',
      overflow: 'hidden',
      pointerEvents: 'none',
    } satisfies Partial<CSSStyleDeclaration>)
    host.appendChild(el)
    this.element = el
  }

  set(entries: LabelEntry[]): void {
    this.entries = entries
    while (this.spans.length > entries.length) this.spans.pop()!.remove()
    while (this.spans.length < entries.length) {
      const s = document.createElement('span')
      Object.assign(s.style, {
        position: 'absolute',
        left: '0',
        top: '0',
        whiteSpace: 'nowrap',
        transform: 'translate(-50%, 0)',
        willChange: 'transform',
      } satisfies Partial<CSSStyleDeclaration>)
      this.element.appendChild(s)
      this.spans.push(s)
    }
    entries.forEach((e, i) => {
      const s = this.spans[i]
      if (s.textContent !== e.text) s.textContent = e.text
      const cls = 'edgelit-label' + (e.className ? ' ' + e.className : '')
      if (s.className !== cls) s.className = cls
    })
  }

  /** Place labels below each node: `offset` extra CSS px under the node's edge. */
  update(camera: Camera, pos: Float32Array, size: Float32Array, visible: Uint8Array, offset = 4): void {
    for (let i = 0; i < this.entries.length; i++) {
      const n = this.entries[i].node
      const s = this.spans[i]
      if (!visible[n]) {
        s.style.display = 'none'
        continue
      }
      const [sx, sy] = camera.worldToScreen(pos[2 * n], pos[2 * n + 1])
      const dy = (size[n] * 0.5) * camera.zoom + offset
      s.style.display = ''
      s.style.transform = `translate(calc(${sx}px - 50%), ${sy + dy}px)`
    }
  }

  destroy(): void {
    this.element.remove()
  }
}
