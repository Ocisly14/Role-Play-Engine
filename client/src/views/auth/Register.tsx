import { FrameImage } from "../../components/FrameImage";
import { RegisterForm } from "../../components/auth/RegisterForm";
import { useBackgroundImage } from "../../hooks/useBackgroundImage";

export default function Register() {
  // Set background image supporting multiple formats (png, jpeg, jpg)
  useBackgroundImage("background", true);

  return (
    <div className="auth-page">
      <div className="auth-frame">
        <FrameImage />
        <div className="auth-container">
          <RegisterForm />
        </div>
      </div>
    </div>
  );
}
