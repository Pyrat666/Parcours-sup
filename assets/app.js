'use strict';

/* ------------------------------------------------------------------ *
 * Client Opendatasoft Explore v2.1
 * ------------------------------------------------------------------ */

const DATASET = 'fr-esr-cartographie_formations_parcoursup';

// Le jeu de données est publié sur plusieurs portails : si le premier ne
// répond pas, on bascule sur le suivant.
const ENDPOINTS = [
  'https://data.enseignementsup-recherche.gouv.fr/api/explore/v2.1',
  'https://data.education.gouv.fr/api/explore/v2.1',
];

const PAGE_SIZE = 100;      // plafond de `limit` sur /records
const MAX_OFFSET = 9900;    // limit + offset ne peut pas dépasser 10 000

let endpoint = ENDPOINTS[0];

async function apiGet(path, params) {
  let lastError;
  for (const base of ENDPOINTS.slice(ENDPOINTS.indexOf(endpoint))) {
    const url = new URL(base + path);
    for (const [key, value] of Object.entries(params || {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
    }
    try {
      const response = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      endpoint = base;
      return await response.json();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

const quote = (value) => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/* ------------------------------------------------------------------ *
 * Arborescence
 * ------------------------------------------------------------------ */

// Ordre par défaut des niveaux. Les champs absents du schéma sont écartés au
// démarrage, ce qui laisse l'application fonctionnelle si le jeu de données
// change de colonnes.
const DEFAULT_LEVELS = ['fl', 'tf', 'nmc', 'nm', 'amg'];

// Champs servant à décrire une formation au dernier niveau.
const RECORD_FIELDS = { titre: 'nm', lieu: 'nmc' };

const state = {
  fields: [],      // schéma du jeu de données
  levelOrder: [],  // { field, enabled } — l'arborescence, ordonnable
  fiche: null,     // champ portant l'URL de la fiche, s'il existe
  path: [],        // { field, value, rank } — le chemin priorisé parcouru
  cards: [],       // cartes du niveau courant
  isLeaf: false,   // true quand on affiche des formations et non des groupes
  offset: 0,
  total: 0,
  partial: false,
};

const el = (id) => document.getElementById(id);

const activeLevels = () => state.levelOrder.filter((level) => level.enabled).map((level) => level.field);

const buildWhere = () =>
  state.path.map((step) => `${step.field} = ${quote(step.value)}`).join(' and ');

function labelOf(fieldName) {
  const field = state.fields.find((item) => item.name === fieldName);
  return field ? (field.label || field.name) : fieldName;
}

/* ------------------------------------------------------------------ *
 * Navigation
 * ------------------------------------------------------------------ */

async function loadLevel() {
  const levels = activeLevels();
  const field = levels[state.path.length];
  state.isLeaf = !field;
  state.offset = 0;

  try {
    if (state.isLeaf) {
      const data = await apiGet(`/catalog/datasets/${DATASET}/records`, {
        where: buildWhere(), limit: PAGE_SIZE, offset: 0,
      });
      state.total = data.total_count || 0;
      state.cards = (data.results || []).map(toFormationCard);
    } else {
      state.cards = await fetchGroups(field, buildWhere());
      state.total = state.cards.length;
    }
    setStatus(state.partial ? 'Liste partielle : regroupement local des cent premières formations.' : null);
  } catch (error) {
    state.cards = [];
    setStatus(`Impossible de joindre l'API. ${error.message}`, true);
  }
  render();
}

/**
 * Valeurs distinctes d'un champ, par ordre de fréquence.
 *
 * L'agrégation ODSQL est la forme la plus précise, mais une erreur serveur
 * renvoyée sans en-tête CORS est indiscernable d'une panne réseau côté
 * navigateur : on redescend donc vers des requêtes de plus en plus simples
 * plutôt que d'échouer sur la première.
 */
async function fetchGroups(field, where) {
  const strategies = [
    {
      nom: 'agrégation',
      run: async () => {
        const data = await apiGet(`/catalog/datasets/${DATASET}/records`, {
          select: `${field}, count(*) as nb`,
          group_by: field,
          order_by: 'nb desc',
          where,
          limit: PAGE_SIZE,
        });
        return (data.results || []).map((row) => row[field]);
      },
    },
    {
      nom: 'facettes',
      run: async () => {
        const data = await apiGet(`/catalog/datasets/${DATASET}/facets`, { facet: field, where });
        const facet = (data.facets || []).find((item) => item.name === field);
        return (facet?.facets || []).map((item) => item.name);
      },
    },
    {
      nom: 'regroupement local',
      partial: true,
      run: async () => {
        const data = await apiGet(`/catalog/datasets/${DATASET}/records`, {
          select: field, where, limit: PAGE_SIZE,
        });
        return [...new Set((data.results || []).map((row) => row[field]))];
      },
    },
  ];

  const failures = [];
  for (const strategy of strategies) {
    try {
      const values = await strategy.run();
      state.partial = Boolean(strategy.partial);
      return values
        .filter((value) => value !== null && value !== undefined && value !== '')
        .map((value) => ({ value }));
    } catch (error) {
      failures.push(`${strategy.nom} : ${error.message}`);
    }
  }
  throw new Error(failures.join(' — '));
}

async function loadMore() {
  state.offset += PAGE_SIZE;
  try {
    const data = await apiGet(`/catalog/datasets/${DATASET}/records`, {
      where: buildWhere(), limit: PAGE_SIZE, offset: Math.min(state.offset, MAX_OFFSET),
    });
    state.cards = state.cards.concat((data.results || []).map(toFormationCard));
    render();
  } catch (error) {
    setStatus(`Chargement interrompu : ${error.message}`, true);
  }
}

function toFormationCard(record) {
  // Ce que le chemin porte déjà n'a pas à être répété sur la carte.
  const seen = new Set(state.path.map((step) => step.value));
  const lieu = record[RECORD_FIELDS.lieu];
  return {
    value: record[RECORD_FIELDS.titre] || 'Formation',
    meta: lieu && !seen.has(lieu) ? lieu : '',
    url: state.fiche && /^https?:\/\//.test(record[state.fiche] || '') ? record[state.fiche] : null,
  };
}

function descend(index) {
  state.path.push({
    field: activeLevels()[state.path.length],
    value: state.cards[index].value,
    rank: index + 1,
  });
  loadLevel();
}

function goTo(depth) {
  state.path = state.path.slice(0, depth);
  loadLevel();
}

/* ------------------------------------------------------------------ *
 * Rendu
 * ------------------------------------------------------------------ */

function setStatus(message, isError) {
  const node = el('status');
  node.hidden = !message;
  node.textContent = message || '';
  node.classList.toggle('error', Boolean(isError));
}

function render() {
  renderBreadcrumb();
  renderDeck();
}

function renderBreadcrumb() {
  const bar = el('breadcrumb');
  bar.replaceChildren();
  if (!state.path.length) return;

  const root = document.createElement('button');
  root.type = 'button';
  root.className = 'crumb';
  root.textContent = 'Tout';
  root.addEventListener('click', () => goTo(0));
  bar.append(root);

  state.path.forEach((step, depth) => {
    const separator = document.createElement('span');
    separator.className = 'crumb-sep';
    separator.textContent = '›';

    const crumb = document.createElement('button');
    crumb.type = 'button';
    crumb.className = 'crumb' + (depth === state.path.length - 1 ? ' current' : '');
    const rank = document.createElement('span');
    rank.className = 'rank';
    rank.textContent = `#${step.rank}`;
    crumb.append(rank, document.createTextNode(step.value));
    crumb.addEventListener('click', () => goTo(depth + 1));

    bar.append(separator, crumb);
  });
}

function renderDeck() {
  const deck = el('deck');
  deck.replaceChildren();

  if (!state.cards.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'Aucun résultat.';
    deck.append(empty);
  }

  state.cards.forEach((card, index) => deck.append(buildCard(card, index)));
  el('deck-more').hidden = !(state.isLeaf && state.cards.length < state.total && state.offset < MAX_OFFSET);
}

function buildCard(card, index) {
  const item = document.createElement('li');
  item.className = 'card';
  item.dataset.index = String(index);

  const body = document.createElement('div');
  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = card.value;
  body.append(label);

  if (card.meta) {
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = card.meta;
    body.append(meta);
  }

  item.append(buildHandle(index), body);

  // Une carte de groupe ouvre le niveau suivant ; une formation renvoie vers
  // sa fiche quand le jeu de données en fournit une.
  if (!state.isLeaf) {
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'open';
    open.setAttribute('aria-label', `Ouvrir ${card.value}`);
    open.textContent = '›';
    open.addEventListener('click', () => descend(index));
    item.append(open);
  } else if (card.url) {
    const open = document.createElement('a');
    open.className = 'open';
    open.href = card.url;
    open.target = '_blank';
    open.rel = 'noopener';
    open.setAttribute('aria-label', `Fiche de ${card.value}`);
    open.textContent = '↗';
    item.append(open);
  }

  attachDrag(item, () => state.cards, renderDeck);
  return item;
}

/** Poignée de glissement : cible tactile large portant aussi le rang. */
function buildHandle(index) {
  const handle = document.createElement('div');
  handle.className = 'drag-handle';
  handle.setAttribute('role', 'button');
  handle.setAttribute('aria-label', `Déplacer — position ${index + 1}`);

  const number = document.createElement('span');
  number.className = 'rank-number';
  number.textContent = String(index + 1);

  const grip = document.createElement('span');
  grip.className = 'grip';
  grip.setAttribute('aria-hidden', 'true');

  handle.append(number, grip);
  return handle;
}

/* ------------------------------------------------------------------ *
 * Réglages : l'arborescence se classe avec le même geste que les cartes
 * ------------------------------------------------------------------ */

function renderSettings() {
  const list = el('levels');
  list.replaceChildren();

  state.levelOrder.forEach((level, index) => {
    const item = document.createElement('li');
    item.className = 'card' + (level.enabled ? '' : ' off');
    item.dataset.index = String(index);

    const body = document.createElement('div');
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = labelOf(level.field);
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = level.field;
    body.append(label, meta);

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'toggle';
    toggle.setAttribute('aria-pressed', String(level.enabled));
    toggle.textContent = level.enabled ? 'Actif' : 'Ignoré';
    toggle.addEventListener('click', () => {
      level.enabled = !level.enabled;
      renderSettings();
    });

    item.append(buildHandle(index), body, toggle);
    attachDrag(item, () => state.levelOrder, renderSettings);
    list.append(item);
  });
}

function toggleSettings(open) {
  const panel = el('settings');
  panel.hidden = !open;
  el('settings-toggle').setAttribute('aria-expanded', String(open));
  if (open) renderSettings();
}

/* ------------------------------------------------------------------ *
 * Glisser-déposer
 *
 * L'API drag-and-drop HTML5 est inopérante sur écran tactile : tout passe
 * par les Pointer Events, identiques au doigt et à la souris.
 * ------------------------------------------------------------------ */

const EDGE = 90;        // zone haute/basse déclenchant le défilement automatique
const SCROLL_STEP = 12;

function move(list, from, to) {
  if (to < 0 || to >= list.length || from === to) return;
  const [item] = list.splice(from, 1);
  list.splice(to, 0, item);
}

function attachDrag(node, getList, rerender) {
  const handle = node.querySelector('.drag-handle');

  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();

    const list = getList();
    const parent = node.parentElement;
    // La capture garde le geste attaché à la poignée même si le doigt sort de
    // la carte ; elle n'est pas indispensable, d'où le filet de sécurité.
    try { handle.setPointerCapture(event.pointerId); } catch { /* sans capture */ }

    let originY = event.clientY;
    let pointer = { x: event.clientX, y: event.clientY };
    document.body.classList.add('is-dragging');
    node.classList.add('dragging');

    /** Échange la carte saisie avec celle survolée, sans reconstruire le DOM. */
    const swapIfNeeded = () => {
      node.style.pointerEvents = 'none';
      const under = document.elementFromPoint(pointer.x, pointer.y);
      node.style.pointerEvents = '';

      const target = under && under.closest('.card');
      if (!target || target === node || target.parentElement !== parent) return;

      const from = Number(node.dataset.index);
      const to = Number(target.dataset.index);
      move(list, from, to);
      parent.insertBefore(node, to > from ? target.nextSibling : target);
      syncIndices(parent);

      // Le nœud a changé de place : on repart de la position actuelle du doigt.
      originY = pointer.y;
      node.style.transform = 'translateY(0px)';
    };

    const autoScroll = setInterval(() => {
      const delta = pointer.y < EDGE ? -SCROLL_STEP
        : pointer.y > window.innerHeight - EDGE ? SCROLL_STEP
        : 0;
      if (!delta) return;
      window.scrollBy(0, delta);
      originY -= delta;
      node.style.transform = `translateY(${pointer.y - originY}px)`;
      swapIfNeeded();
    }, 16);

    const onMove = (moveEvent) => {
      moveEvent.preventDefault();
      pointer = { x: moveEvent.clientX, y: moveEvent.clientY };
      node.style.transform = `translateY(${pointer.y - originY}px)`;
      swapIfNeeded();
    };

    const onEnd = () => {
      clearInterval(autoScroll);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
      node.style.transform = '';
      node.classList.remove('dragging');
      document.body.classList.remove('is-dragging');
      rerender();
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
  });
}

/** Renumérote les cartes après un déplacement fait directement dans le DOM. */
function syncIndices(parent) {
  Array.from(parent.children).forEach((child, index) => {
    child.dataset.index = String(index);
    const badge = child.querySelector('.rank-number');
    if (badge) badge.textContent = String(index + 1);
  });
}

/* ------------------------------------------------------------------ *
 * Dictionnaire des champs (?schema)
 * ------------------------------------------------------------------ */

function renderSchema() {
  const deck = el('deck');
  deck.replaceChildren();

  state.fields.forEach((field) => {
    const item = document.createElement('li');
    item.className = 'card schema-row';

    const body = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'label';
    name.textContent = `${field.name} — ${field.type}`;

    const label = document.createElement('div');
    label.className = 'meta';
    label.textContent = [field.label, field.description].filter(Boolean).join(' · ') || '(sans libellé)';

    body.append(name, label);
    item.append(body);
    deck.append(item);
  });
}

/* ------------------------------------------------------------------ *
 * Démarrage
 * ------------------------------------------------------------------ */

async function start() {
  let metadata;
  try {
    metadata = await apiGet(`/catalog/datasets/${DATASET}`, {});
  } catch (error) {
    setStatus(
      `Impossible de lire le schéma (${error.message}). ` +
      'Ouverte en file://, la page ne peut pas appeler l’API : sers-la en HTTP.',
      true,
    );
    return;
  }

  state.fields = metadata.fields || metadata.dataset?.fields || [];
  if (!state.fields.length) {
    setStatus('Schéma vide : le jeu de données a peut-être changé d’identifiant.', true);
    return;
  }

  if (new URLSearchParams(location.search).has('schema')) {
    renderSchema();
    return;
  }

  const present = new Set(state.fields.map((field) => field.name));
  state.levelOrder = DEFAULT_LEVELS
    .filter((field) => present.has(field))
    .map((field) => ({ field, enabled: true }));

  state.fiche = state.fields
    .map((field) => field.name)
    .find((name) => /url|lien|fiche/i.test(name)) || null;

  if (!state.levelOrder.length) {
    setStatus('Aucun des champs attendus n’est présent dans le jeu de données.', true);
    return;
  }

  await loadLevel();
}

el('settings-toggle').addEventListener('click', () => {
  toggleSettings(el('settings').hidden);
});

el('settings-apply').addEventListener('click', () => {
  toggleSettings(false);
  state.path = [];
  loadLevel();
});

el('load-more').addEventListener('click', loadMore);

start();
