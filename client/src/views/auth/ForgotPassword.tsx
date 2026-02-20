import { FrameImage } from "../../components/FrameImage";
import { ForgotPasswordForm } from "../../components/auth/ForgotPasswordForm";
import { useBackgroundImage } from "../../hooks/useBackgroundImage";

export default function ForgotPassword() {
  useBackgroundImage("background", true);

  return (
    <div className="auth-page">
      <div className="auth-frame">
        <FrameImage />
        <div className="auth-container">
          <ForgotPasswordForm />
        </div>
      </div>
    </div>
  );
}
