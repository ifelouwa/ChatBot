import Link from "next/link";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

type Row = {
  id: string;
  created_at: Date;
  name: string | null;
  phone: string | null;
  need: string | null;
  handoff_reason: string | null;
  failed_alerts: number;
};

const when = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" });

export default async function AdminPage() {
  const { rows } = await db().query<Row>(
    `SELECT c.id, COALESCE(l.created_at, h.created_at) AS created_at,
            l.name, l.phone, l.need, h.reason AS handoff_reason,
            (SELECT count(*)::int FROM notifications n
              WHERE n.conversation_id = c.id AND n.status = 'failed') AS failed_alerts
       FROM conversations c
       LEFT JOIN leads l ON l.conversation_id = c.id
       LEFT JOIN handoffs h ON h.conversation_id = c.id
      WHERE l.id IS NOT NULL OR h.id IS NOT NULL
      ORDER BY COALESCE(l.created_at, h.created_at) DESC
      LIMIT 200`,
  );

  return (
    <>
      <h1>Lead inbox</h1>
      {rows.length === 0 ? (
        <div className="admin-empty">No leads yet. They appear here as soon as a visitor leaves their details.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Received</th>
                <th scope="col">Name</th>
                <th scope="col">Phone</th>
                <th scope="col">Need</th>
                <th scope="col">Status</th>
                <th scope="col">Chat</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{when.format(row.created_at)}</td>
                  <td>{row.name ?? "Not provided"}</td>
                  <td>{row.phone ? <a href={`tel:${row.phone.replace(/[^\d+]/g, "")}`}>{row.phone}</a> : "Not provided"}</td>
                  <td>{row.need ?? row.handoff_reason}</td>
                  <td>
                    {row.handoff_reason ? (
                      <span className="badge badge-alert">Needs a person</span>
                    ) : (
                      <span className="badge">Lead</span>
                    )}
                    {row.failed_alerts > 0 && <div className="error-text">Alert failed</div>}
                  </td>
                  <td>
                    <Link href={`/admin/conversations/${row.id}`}>Open</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
