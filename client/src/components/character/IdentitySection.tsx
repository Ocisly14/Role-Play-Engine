import React from "react";

interface IdentitySectionProps {
  form: Record<string, string>;
  onChange: (key: string, value: string) => void;
  occupations: any[];
  selectedOccupation: any;
  onSelectOccupation: (occupation: any) => void;
}

export const IdentitySection: React.FC<IdentitySectionProps> = ({
  form,
  onChange,
  occupations,
  selectedOccupation,
  onSelectOccupation,
}) => {
  return (
    <>
      <div className="section-title">Identity</div>
      <table>
        <tbody>
          <tr>
            <th>Era</th>
            <td>
              <input
                name="era"
                placeholder="1920s Character"
                value={form.era || ""}
                onChange={(e) => onChange("era", e.target.value)}
              />
            </td>
            <th>Name</th>
            <td>
              <input
                name="name"
                placeholder="Name"
                value={form.name || ""}
                onChange={(e) => onChange("name", e.target.value)}
              />
            </td>
            <th>Occupation</th>
            <td>
              <select
                name="occupation"
                value={form.occupation || ""}
                onChange={(e) => {
                  const occupationName = e.target.value;
                  onChange("occupation", occupationName);
                  const selected = occupations.find(
                    (occ) => occ.name_en === occupationName
                  );
                  onSelectOccupation(selected);
                }}
                style={{ width: "100%", padding: "4px" }}
              >
                <option value="">Select occupation...</option>
                {occupations.map((occ) => (
                  <option key={occ.id} value={occ.name_en}>
                    {occ.name_en}
                  </option>
                ))}
              </select>
            </td>
          </tr>
          <tr>
            <th>Age</th>
            <td>
              <input
                name="age"
                type="number"
                min="1"
                placeholder="32"
                value={form.age || ""}
                onChange={(e) => onChange("age", e.target.value)}
              />
            </td>
            <th>Gender</th>
            <td>
              <input
                name="gender"
                placeholder="Male / Female"
                value={form.gender || ""}
                onChange={(e) => onChange("gender", e.target.value)}
              />
            </td>
            <th>Residence</th>
            <td>
              <input
                name="residence"
                placeholder="New York"
                value={form.residence || ""}
                onChange={(e) => onChange("residence", e.target.value)}
              />
            </td>
          </tr>
          <tr>
            <th>Birthplace</th>
            <td colSpan={5}>
              <input
                name="birthplace"
                placeholder="Boston"
                value={form.birthplace || ""}
                onChange={(e) => onChange("birthplace", e.target.value)}
              />
            </td>
          </tr>
        </tbody>
      </table>
    </>
  );
};
