import type React from "react";
import { useTranslation } from "react-i18next";

interface NotesSectionProps {
  form: Record<string, string>;
  onChange: (key: string, value: string) => void;
}

export const NotesSection: React.FC<NotesSectionProps> = ({
  form,
  onChange,
}) => {
  const { t } = useTranslation("character");
  return (
    <>
      <div className="section-title">{t("notes.title")}</div>
      <div className="notes-grid">
        <table>
          <tbody>
            <tr>
              <th>{t("notes.appearance")}</th>
            </tr>
            <tr>
              <td>
                <textarea
                  name="appearance"
                  placeholder={t("notes.appearancePlaceholder")}
                  value={form.appearance || ""}
                  onChange={(e) => onChange("appearance", e.target.value)}
                />
              </td>
            </tr>
          </tbody>
        </table>
        <table>
          <tbody>
            <tr>
              <th>{t("notes.ideology")}</th>
            </tr>
            <tr>
              <td>
                <textarea
                  name="ideology"
                  placeholder={t("notes.ideologyPlaceholder")}
                  value={form.ideology || ""}
                  onChange={(e) => onChange("ideology", e.target.value)}
                />
              </td>
            </tr>
          </tbody>
        </table>
        <table>
          <tbody>
            <tr>
              <th>{t("notes.people")}</th>
            </tr>
            <tr>
              <td>
                <textarea
                  name="people"
                  placeholder={t("notes.peoplePlaceholder")}
                  value={form.people || ""}
                  onChange={(e) => onChange("people", e.target.value)}
                />
              </td>
            </tr>
          </tbody>
        </table>
        <table>
          <tbody>
            <tr>
              <th>{t("notes.gear")}</th>
            </tr>
            <tr>
              <td>
                <textarea
                  name="gear"
                  placeholder={t("notes.gearPlaceholder")}
                  value={form.gear || ""}
                  onChange={(e) => onChange("gear", e.target.value)}
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="section-title">{t("notes.backstory")}</div>
      <table>
        <tbody>
          <tr>
            <td>
              <textarea
                name="backstory"
                placeholder={t("notes.backstoryPlaceholder")}
                value={form.backstory || ""}
                onChange={(e) => onChange("backstory", e.target.value)}
              />
            </td>
          </tr>
        </tbody>
      </table>
    </>
  );
};
