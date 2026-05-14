import { FrameImage } from "../../components/FrameImage";
import { ResetPasswordForm } from "../../components/auth/ResetPasswordForm";
import { useBackgroundImage } from "../../hooks/useBackgroundImage";

export default function ResetPassword() {
  useBackgroundImage("background", true);

  return (
    <div className="auth-page">
      <div className="auth-frame">
        <FrameImage />
        <div className="auth-container">
          <ResetPasswordForm />
        </div>
      </div>
    </div>
  );
}
