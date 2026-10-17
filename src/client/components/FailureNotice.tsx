import {describeFailure, type ClientFailure} from '../failures';
import './FailureNotice.css';

type NoticeAction = {label: string; onClick: () => void; disabled?: boolean};
export function FailureNotice({failure, action, secondaryAction, inline = false, announce = true, messageId}: {
  failure: ClientFailure; action?: NoticeAction; secondaryAction?: NoticeAction; inline?: boolean; announce?: boolean; messageId?: string;
}) {
  const presentation = describeFailure(failure);
  return <div className={`failure-notice${inline ? ' failure-notice--inline' : ''}`} role={announce ? 'status' : undefined}>
    <div className="failure-notice__content"><span className="failure-notice__mark" aria-hidden="true">{presentation.location === 'startingPoint' ? '?' : '!'}</span><div><h3>{presentation.title}</h3><p id={messageId}>{failure.message}</p></div></div>
    {(action || secondaryAction) && <div className="failure-notice__actions">{action && <button className="button button--glass button--small" type="button" disabled={action.disabled} onClick={action.onClick}>{action.label}</button>}{secondaryAction && <button className="button button--glass button--small" type="button" disabled={secondaryAction.disabled} onClick={secondaryAction.onClick}>{secondaryAction.label}</button>}</div>}
  </div>;
}
