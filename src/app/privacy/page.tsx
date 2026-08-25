import type { Metadata } from "next";
import { LegalPage } from "@/components/marketing/legal-page";

export const metadata: Metadata = {
  title: "Privacy Policy — Asael",
  description: "How the private Asael application processes connected Google data and AI requests.",
};

export default function PrivacyPage() {
  return (
    <LegalPage
      eyebrow="Your data, under your control"
      title="Privacy Policy"
      summary="Asael is a private, single-owner AI workspace. It processes only the information you provide or explicitly connect so it can organize, retrieve, and act on your behalf."
      sections={[
        {
          title: "Information Asael processes",
          paragraphs: [
            "Asael may process prompts, notes, files, projects, agent activity, and memories you add to the application.",
            "When you authorize Google, Asael requests read-only access to the Gmail messages, Calendar events, and Drive files needed for the features you choose. Basic Google identity information is used to associate the connection with your private workspace.",
          ],
        },
        {
          title: "How information is used",
          paragraphs: [
            "Connected information is used to answer your requests, build private search context, generate summaries and briefs, and run automations you initiate. Asael does not sell personal information or use connected Google data for advertising.",
            "AI providers may receive the minimum context required to perform a requested task. Provider calls are made according to the application's configured privacy and retention controls.",
          ],
        },
        {
          title: "Storage, security, and deletion",
          paragraphs: [
            "Access tokens and application secrets are stored in protected server-side configuration and are not exposed to the browser or committed to source control. Access is limited to the private application owner.",
            "You may disconnect Google at any time from Asael. You may also revoke access from your Google Account. Disconnecting stops future synchronization; source records and generated memories can be reviewed or deleted from Asael.",
          ],
        },
        {
          title: "Google API data",
          paragraphs: [
            "Asael's use and transfer of information received from Google APIs follows the Google API Services User Data Policy, including its Limited Use requirements.",
          ],
        },
        {
          title: "Contact",
          paragraphs: [
            "For questions about this policy or a data request, contact the application owner at benniejoseph.r@gmail.com.",
          ],
        },
      ]}
    />
  );
}
