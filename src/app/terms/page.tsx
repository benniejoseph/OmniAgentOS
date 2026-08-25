import type { Metadata } from "next";
import { LegalPage } from "@/components/marketing/legal-page";

export const metadata: Metadata = {
  title: "Terms of Use — Asael",
  description: "Terms governing use of the private Asael AI application.",
};

export default function TermsPage() {
  return (
    <LegalPage
      eyebrow="Private application terms"
      title="Terms of Use"
      summary="Asael is a private AI application operated for its owner's personal use. These terms describe the safeguards and responsibilities that apply when using its agents and integrations."
      sections={[
        {
          title: "Permitted use",
          paragraphs: [
            "Use Asael only with accounts, information, and systems you are authorized to access. Do not use agents to violate law, third-party rights, service terms, or security controls.",
          ],
        },
        {
          title: "Agent output and actions",
          paragraphs: [
            "AI output can be incomplete or incorrect. Review important conclusions and approve consequential external actions before relying on them. Asael's approval controls are designed to support, not replace, your judgment.",
          ],
        },
        {
          title: "Connected services",
          paragraphs: [
            "Google and other connected services remain governed by their own terms. You may revoke a connection at any time. Features can change when providers modify their APIs, quotas, or policies.",
          ],
        },
        {
          title: "Availability",
          paragraphs: [
            "The application is provided as available for private use without a guarantee of uninterrupted operation. Maintain independent copies of information that is essential to you.",
          ],
        },
        {
          title: "Contact",
          paragraphs: [
            "Questions about these terms may be sent to benniejoseph.r@gmail.com.",
          ],
        },
      ]}
    />
  );
}
