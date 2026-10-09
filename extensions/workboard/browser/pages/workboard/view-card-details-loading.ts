import { html } from "lit";
import { renderDialog } from "../../components/host-components.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import type { WorkboardCard } from "../../lib/workboard/index.ts";

export const workboardDetailDialogStyle =
  "--openclaw-modal-width: 620px; --openclaw-modal-backdrop-filter: none; --wa-color-overlay-modal: rgba(0, 0, 0, 0.24);";

/** A summary card has no notes or history to show or edit; the page loads its full copy. */
export function renderCardDetailsLoading(
  card: WorkboardCard,
  ids: { drawerId: string; titleId: string },
  closeDetails: () => void,
  props: { onRequestUpdate?: () => void },
) {
  const close = () => {
    closeDetails();
    props.onRequestUpdate?.();
    return true;
  };
  return renderDialog(
    {
      className: "drawer drawer--floating",
      label: card.title,
      style: workboardDetailDialogStyle,
      onCancel: close,
    },
    html`
      <aside id=${ids.drawerId} class="workboard-detail-drawer" aria-busy="true">
        <div class="workboard-detail">
          <header class="workboard-detail__header">
            <h2 id=${ids.titleId}>${card.title}</h2>
            <div class="workboard-detail__header-actions">
              <button
                class="btn btn--icon workboard-detail__icon workboard-detail__close"
                type="button"
                aria-label=${t("common.close")}
                @click=${close}
              >
                ${icons.x}
              </button>
            </div>
          </header>
          <div class="workboard-detail__body">
            <p class="workboard-empty">${t("workboard.loadingCard")}</p>
          </div>
        </div>
      </aside>
    `,
  );
}
