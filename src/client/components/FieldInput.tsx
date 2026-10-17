import type { ReactNode } from 'react';
import { Icon } from './Icon';
import './FieldInput.css';

export function FieldInput({icon, children, className = ''}: {icon: 'music' | 'pin'; children: ReactNode; className?: string}) {
  return <div className={`field-input ${className}`}><Icon name={icon} size={19} />{children}</div>;
}
