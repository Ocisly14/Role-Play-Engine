import type React from "react";
import { useTranslation } from "react-i18next";

interface WeaponsSectionProps {
  form: Record<string, string>;
  onChange: (key: string, value: string) => void;
  weaponsList: any[];
}

export const WeaponsSection: React.FC<WeaponsSectionProps> = ({
  form,
  onChange,
  weaponsList,
}) => {
  const { t } = useTranslation("character");
  const weapons = [0, 1, 2].map((i) => ({
    name: form[`weapon_${i}_name`] || "",
    skill: form[`weapon_${i}_skill`] || "",
    damage: form[`weapon_${i}_damage`] || "",
    range: form[`weapon_${i}_range`] || "",
    attacks: form[`weapon_${i}_attacks`] || "",
    ammo: form[`weapon_${i}_ammo`] || "",
  }));

  const items = [0, 1, 2, 3, 4].map((i) => ({
    name: form[`item_${i}_name`] || "",
    quantity: form[`item_${i}_quantity`] || "",
    description: form[`item_${i}_description`] || "",
  }));

  return (
    <>
      <div className="section-title">{t("weapons.title")}</div>
      <table>
        <tbody>
          <tr>
            <th>{t("weapons.weaponHeader")}</th>
            <th>{t("weapons.skillHeader")}</th>
            <th>{t("weapons.damage")}</th>
            <th>{t("weapons.range")}</th>
            <th>{t("weapons.attacksHeader")}</th>
            <th>{t("weapons.ammo")}</th>
          </tr>
          {weapons.map((w, i) => (
            <tr className="weapon-row" key={i}>
              <td>
                <select
                  name={`weapon_${i}_name`}
                  value={w.name}
                  onChange={(e) => {
                    const selectedWeaponName = e.target.value;
                    onChange(`weapon_${i}_name`, selectedWeaponName);

                    // Auto-fill weapon stats if a predefined weapon is selected
                    if (selectedWeaponName) {
                      const selectedWeapon = weaponsList.find(
                        (weapon) => weapon.name === selectedWeaponName
                      );
                      if (selectedWeapon) {
                        onChange(`weapon_${i}_skill`, selectedWeapon.skill);
                        onChange(`weapon_${i}_damage`, selectedWeapon.damage);
                        onChange(`weapon_${i}_range`, selectedWeapon.range);
                        onChange(
                          `weapon_${i}_attacks`,
                          String(selectedWeapon.attacks_per_round)
                        );
                        onChange(
                          `weapon_${i}_ammo`,
                          selectedWeapon.ammo ? String(selectedWeapon.ammo) : ""
                        );
                      }
                    }
                  }}
                  style={{ width: "100%", padding: "4px" }}
                >
                  <option value="">{t("weapons.selectWeapon")}</option>
                  {weaponsList.map((weapon) => (
                    <option key={weapon.name} value={weapon.name}>
                      {weapon.name}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <input
                  name={`weapon_${i}_skill`}
                  placeholder={i === 0 ? "Handgun" : "Skill"}
                  value={w.skill}
                  onChange={(e) =>
                    onChange(`weapon_${i}_skill`, e.target.value)
                  }
                />
              </td>
              <td>
                <input
                  name={`weapon_${i}_damage`}
                  placeholder={i === 0 ? "1d10" : "-"}
                  value={w.damage}
                  onChange={(e) =>
                    onChange(`weapon_${i}_damage`, e.target.value)
                  }
                />
              </td>
              <td>
                <input
                  name={`weapon_${i}_range`}
                  placeholder={i === 0 ? "15" : "-"}
                  value={w.range}
                  onChange={(e) =>
                    onChange(`weapon_${i}_range`, e.target.value)
                  }
                />
              </td>
              <td>
                <input
                  name={`weapon_${i}_attacks`}
                  placeholder={i === 0 ? "1" : "-"}
                  value={w.attacks}
                  onChange={(e) =>
                    onChange(`weapon_${i}_attacks`, e.target.value)
                  }
                />
              </td>
              <td>
                <input
                  name={`weapon_${i}_ammo`}
                  placeholder={i === 0 ? "6" : "-"}
                  value={w.ammo}
                  onChange={(e) => onChange(`weapon_${i}_ammo`, e.target.value)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="section-title">{t("weapons.itemsTitle")}</div>
      <table>
        <tbody>
          <tr>
            <th>{t("weapons.itemName")}</th>
            <th style={{ width: "100px" }}>{t("weapons.quantity")}</th>
            <th>{t("weapons.description")}</th>
          </tr>
          {items.map((item, i) => (
            <tr className="item-row" key={i}>
              <td>
                <input
                  name={`item_${i}_name`}
                  placeholder={i === 0 ? "Flashlight" : "Item name"}
                  value={item.name}
                  onChange={(e) => onChange(`item_${i}_name`, e.target.value)}
                  style={{ width: "100%" }}
                />
              </td>
              <td>
                <input
                  name={`item_${i}_quantity`}
                  type="number"
                  min="1"
                  placeholder={i === 0 ? "1" : "-"}
                  value={item.quantity}
                  onChange={(e) =>
                    onChange(`item_${i}_quantity`, e.target.value)
                  }
                  style={{ width: "100%" }}
                />
              </td>
              <td>
                <input
                  name={`item_${i}_description`}
                  placeholder={
                    i === 0 ? "Battery-powered, heavy" : "Optional description"
                  }
                  value={item.description}
                  onChange={(e) =>
                    onChange(`item_${i}_description`, e.target.value)
                  }
                  style={{ width: "100%" }}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
};
