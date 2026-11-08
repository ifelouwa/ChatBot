import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Lead inbox",
  robots: { index: false, follow: false },
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <main className="admin">{children}</main>;
}
