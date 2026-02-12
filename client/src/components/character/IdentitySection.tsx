import React from "react";
import { useTranslation } from "react-i18next";

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
  const { t } = useTranslation('character');
  return (
    <>
      <div className="section-title">{t('identity.title')}</div>
      <table>
        <tbody>
          <tr>
            <th>{t('identity.era')}</th>
            <td>
              <input
                name="era"
                placeholder={t('identity.eraPlaceholder')}
                value={form.era || ""}
                onChange={(e) => onChange("era", e.target.value)}
              />
            </td>
            <th>{t('identity.name')}</th>
            <td>
              <input
                name="name"
                placeholder={t('identity.namePlaceholder')}
                value={form.name || ""}
                onChange={(e) => onChange("name", e.target.value)}
              />
            </td>
            <th>{t('identity.occupation')}</th>
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
                  onSelectOccupation(selected || null);
                }}
                style={{ width: "100%", padding: "4px" }}
              >
                <option value="">{t('identity.occupationPlaceholder')}</option>
                {occupations.map((occ) => (
                  <option key={occ.id} value={occ.name_en}>
                    {occ.name_en}
                  </option>
                ))}
              </select>
            </td>
          </tr>
          <tr>
            <th>{t('identity.age')}</th>
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
            <th>{t('identity.gender')}</th>
            <td>
              <input
                name="gender"
                placeholder={t('identity.genderPlaceholder')}
                value={form.gender || ""}
                onChange={(e) => onChange("gender", e.target.value)}
              />
            </td>
            <th>{t('identity.residence')}</th>
            <td>
              <input
                name="residence"
                placeholder={t('identity.residencePlaceholder')}
                value={form.residence || ""}
                onChange={(e) => onChange("residence", e.target.value)}
              />
            </td>
          </tr>
          <tr>
            <th>{t('identity.birthplace')}</th>
            <td colSpan={5}>
              <input
                name="birthplace"
                placeholder={t('identity.birthplacePlaceholder')}
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
