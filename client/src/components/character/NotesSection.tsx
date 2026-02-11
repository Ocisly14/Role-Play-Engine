import React from "react";

interface NotesSectionProps {
  form: Record<string, string>;
  onChange: (key: string, value: string) => void;
}

export const NotesSection: React.FC<NotesSectionProps> = ({
  form,
  onChange,
}) => {
  return (
    <>
      <div className="section-title">Portrait & Notes</div>
      <div className="notes-grid">
        <table>
          <tbody>
            <tr>
              <th>Appearance</th>
            </tr>
            <tr>
              <td>
                <textarea
                  name="appearance"
                  placeholder="Describe appearance, attire, scars, mannerisms..."
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
              <th>Traits / Ideology</th>
            </tr>
            <tr>
              <td>
                <textarea
                  name="ideology"
                  placeholder="Beliefs, politics, religion, personality quirks..."
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
              <th>Significant People</th>
            </tr>
            <tr>
              <td>
                <textarea
                  name="people"
                  placeholder="Important people, mentors, family, contacts..."
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
              <th>Gear & Assets</th>
            </tr>
            <tr>
              <td>
                <textarea
                  name="gear"
                  placeholder="Equipment, items, assets, funds..."
                  value={form.gear || ""}
                  onChange={(e) => onChange("gear", e.target.value)}
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="section-title">Background Story</div>
      <table>
        <tbody>
          <tr>
            <td>
              <textarea
                name="backstory"
                placeholder="Background story, cases, motivations, fears, secrets..."
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
