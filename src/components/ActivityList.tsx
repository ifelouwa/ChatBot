export type ActivityStatus = "done" | "sending" | "retrying" | "failed";
export type ActivityItem = { key: string; label: string; detail: string; status: ActivityStatus; at: string };

const STATUS_TEXT: Record<ActivityStatus, string> = {
  done: "Done",
  sending: "Sending",
  retrying: "Retrying",
  failed: "Failed",
};

const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/** The behind-the-scenes feed: what the automation has really done in this chat. */
export function ActivityList({ items }: { items: ActivityItem[] }) {
  return (
    <div className="activity">
      <div className="activity-heading">
        <h2>Behind the scenes</h2>
        <p>What the automation has done in this chat, read straight from the database.</p>
      </div>
      {items.length === 0 ? (
        <p className="activity-empty">
          Nothing yet. Leave your details or ask for a person, and each step will appear here as it happens.
        </p>
      ) : (
        <ol className="activity-list" aria-live="polite">
          {items.map((item) => (
            <li className="activity-item" key={item.key}>
              <span className={`activity-dot activity-dot-${item.status}`} aria-hidden="true" />
              <div className="activity-body">
                <div className="activity-label">{item.label}</div>
                {item.detail && <div className="activity-detail">{item.detail}</div>}
                <div className="activity-meta">
                  <span className={`activity-status activity-status-${item.status}`}>{STATUS_TEXT[item.status]}</span>
                  <time dateTime={item.at}>{time.format(new Date(item.at))}</time>
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
