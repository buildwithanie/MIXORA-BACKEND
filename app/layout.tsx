import type { ReactNode } from "react";

export const metadata = { title: "MIXORA Catalog", description: "Licensed offline music catalog" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body style={{ fontFamily: "system-ui", background: "#100b1b", color: "white", margin: 0 }}>{children}</body></html>;
}
