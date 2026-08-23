import { permanentRedirect } from "next/navigation";

export default function SignupPage(): never {
  permanentRedirect("/login");
}
