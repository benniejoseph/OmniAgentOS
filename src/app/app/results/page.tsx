import type { Metadata } from "next";
import { ResultsCenter } from "@/components/results-center";

export const metadata: Metadata = {
  title: "Results",
};

export default function ResultsPage() {
  return <ResultsCenter />;
}
