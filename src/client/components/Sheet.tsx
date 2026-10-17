import {useEffect, useId, useRef, type ReactNode} from 'react';
import {Icon} from './Icon';
import './Sheet.css';

export function Sheet({open, onClose, onBack, backLabel = 'Back', title, titleContent, className = '', flush = false, compact = false, conversation = false, immersive = false, headerActions, children}: {
  open: boolean; onClose: () => void; onBack?: () => void; backLabel?: string; title: string; flush?: boolean; compact?: boolean;
  conversation?: boolean; immersive?: boolean; className?: string; titleContent?: ReactNode; headerActions?: ReactNode; children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null), body = useRef<HTMLDivElement>(null), heading = useRef<HTMLHeadingElement>(null), id = useId();
  const previousTitle = useRef(title);
  useEffect(() => {
    const dialog = ref.current;
    if (open && !dialog?.open) {dialog?.showModal(); body.current?.scrollTo({top: 0});}
    else if (!open && dialog?.open) dialog.close();
    else if (open && previousTitle.current !== title) {body.current?.scrollTo({top: 0}); heading.current?.focus();}
    previousTitle.current = title;
  }, [open, title]);
  useEffect(() => {
    if (!open || !conversation) return;
    const viewport = window.visualViewport;
    function resize() {
      const height = viewport?.height ?? window.innerHeight;
      const bottom = Math.max(0, window.innerHeight - height - (viewport?.offsetTop ?? 0));
      ref.current?.style.setProperty('--sheet-visible-height', `${Math.round(height)}px`);
      ref.current?.style.setProperty('--sheet-keyboard-offset', `${Math.round(bottom)}px`);
    }
    resize();
    viewport?.addEventListener('resize', resize);
    viewport?.addEventListener('scroll', resize);
    return () => {viewport?.removeEventListener('resize', resize); viewport?.removeEventListener('scroll', resize);};
  }, [open, conversation]);
  return <dialog ref={ref} className={`sheet${flush ? ' sheet--flush' : ''}${compact ? ' sheet--compact' : ''}${conversation ? ' sheet--conversation' : ''}${immersive ? ' sheet--immersive' : ''}${className ? ` ${className}` : ''}`} aria-labelledby={id} onCancel={event => {event.preventDefault(); onClose();}} onClick={event => {
    if (event.target !== event.currentTarget) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
  }}><div className="sheet__handle" aria-hidden="true" /><header className="sheet__header">{onBack && <button className="icon-control sheet__back" type="button" onClick={onBack} aria-label={backLabel}><Icon name="arrow" size={18} /></button>}<h2 ref={heading} tabIndex={-1} id={id} className={immersive ? 'sr-only' : undefined}>{titleContent ?? title}</h2>{headerActions}<button className="icon-control" type="button" onClick={onClose} aria-label={`Close ${title.toLowerCase()}`}><Icon name="close" size={18} /></button></header><div ref={body} className="sheet__body">{children}</div></dialog>;
}
