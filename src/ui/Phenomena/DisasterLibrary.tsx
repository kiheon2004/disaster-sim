/**
 * Disaster library (Phase 35.5): every implemented phenomenon on one screen — a compact grid of cards (icon, name, one-line
 * description), searchable in Korean and English (names, short descriptions and the command keywords), filtered by
 * category / favourites / recent. A card arms map placement (select → click the map → run); a phenomenon without a
 * position (map-wide wind …) is added at once. Favourites and recent live in the browser only (never in the world file).
 */
import { useMemo, useState } from 'react';
import { translate, useLocale, useT, type MessageKey } from '@/i18n/i18n';
import { phenomena } from '@/phenomena/registry';
import { CATALOG, CATEGORIES, catalogOf, placeable, type Category } from '@/phenomena/catalog';
import { armPlacement } from '@/app/placementActions';
import { usePlacementStore } from '@/ui/placement/placementStore';
import { Icon } from '@/ui/common/Icon';
import s from './Phenomena.module.css';

type Filter = 'all' | 'favorites' | 'recent' | Category;

export function DisasterLibrary() {
  const t = useT();
  const locale = useLocale();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const favorites = usePlacementStore((st) => st.favorites);
  const recent = usePlacementStore((st) => st.recent);
  const armed = usePlacementStore((st) => st.type);
  const defs = useMemo(() => phenomena.listImplemented().filter((d) => CATALOG[d.type]), []);
  const q = query.trim().toLowerCase();
  const visible = defs.filter((d) => {
    const c = catalogOf(d.type)!;
    if (filter === 'favorites' && !favorites.includes(d.type)) return false;
    if (filter === 'recent' && !recent.includes(d.type)) return false;
    if (CATEGORIES.includes(filter as Category) && c.category !== filter) return false;
    if (!q) return true;
    const hay = [translate('ko', d.labelKey), translate('en', d.labelKey), translate('ko', c.shortKey), translate('en', c.shortKey), translate(locale, `lib.cat.${c.category}` as MessageKey), d.type].join(' ').toLowerCase();
    return hay.includes(q) || d.keywords.test(q);
  });
  if (filter === 'recent') visible.sort((a, b) => recent.indexOf(a.type) - recent.indexOf(b.type));
  const chips: { id: Filter; label: string; n?: number }[] = [
    { id: 'all', label: t('lib.all') },
    { id: 'favorites', label: `★ ${t('lib.favorites')}`, n: favorites.length },
    { id: 'recent', label: t('lib.recent'), n: recent.length },
    ...CATEGORIES.filter((c) => defs.some((d) => catalogOf(d.type)!.category === c)).map((c) => ({ id: c as Filter, label: t(`lib.cat.${c}` as MessageKey) })),
  ];

  return (
    <div className={s.library} data-testid="disaster-library">
      <div className={s.search}>
        <Icon name="search" size={13} />
        <input type="search" value={query} placeholder={t('lib.search')} aria-label={t('lib.search')} data-testid="disaster-search"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && visible.length) armPlacement(visible[0].type); if (e.key === 'Escape') setQuery(''); }} />
      </div>
      <div className={s.chips} role="tablist" aria-label={t('lib.title')}>
        {chips.map((c) => (
          <button key={c.id} role="tab" aria-selected={filter === c.id} className={s.chip} onClick={() => setFilter(c.id)} data-filter={c.id}>
            {c.label}{c.n ? <span className={s.chipN}>{c.n}</span> : null}
          </button>
        ))}
      </div>
      <div className={s.grid}>
        {visible.map((d) => {
          const c = catalogOf(d.type)!;
          const fav = favorites.includes(d.type);
          const pos = placeable(d.type, d.defaults());
          return (
            <div key={d.type} className={s.card} data-type={d.type} data-armed={armed === d.type} data-category={c.category}>
              <button className={s.cardMain} onClick={() => armPlacement(d.type)} title={pos ? t('lib.place') : t('lib.addGlobal')} data-testid={`lib-${d.type}`}>
                <span className={s.cardIcon}><Icon name={d.icon as 'wind'} size={16} /></span>
                <span className={s.cardText}>
                  <b>{t(d.labelKey)}</b>
                  <span>{t(c.shortKey)}</span>
                </span>
                <span className={s.cardKind}>{pos ? <Icon name="place" size={12} /> : <Icon name="globe" size={12} />}</span>
              </button>
              <button className={s.star} aria-pressed={fav} title={t(fav ? 'lib.fav.remove' : 'lib.fav.add')} onClick={() => usePlacementStore.getState().toggleFavorite(d.type)}>
                <Icon name="star" size={11} />
              </button>
            </div>
          );
        })}
        {visible.length === 0 && <div className={s.empty}>{t('lib.empty')}</div>}
      </div>
    </div>
  );
}
