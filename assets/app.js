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
 * Détection des champs dans le schéma
 *
 * Les noms de colonnes du jeu de données sont courts et susceptibles de
 * changer : ils sont résolus depuis le schéma renvoyé par l'API plutôt que
 * codés en dur.
 * ------------------------------------------------------------------ */

const HINTS = {
  niveau1:       { names: ['tf', 'type_formation', 'typeformation'], label: /type\s*d[e']?\s*formation/i },
  niveau2:       { names: ['fl', 'fil', 'filiere', 'sous_filiere'],  label: /fili[eè]re|sp[ée]cialit[ée]/i },
  etablissement: { names: ['nm', 'etablissement', 'nom_etablissement', 'lib_etab'], label: /[ée]tablissement/i },
  commune:       { names: ['nmc', 'commune', 'ville', 'nom_commune'], label: /commune|ville/i },
  fiche:         { names: ['url', 'url_fiche', 'lien', 'fiche'], label: /url|lien|fiche/i },
};

function detectField(fields, hint) {
  const byName = fields.find((f) => hint.names.includes(f.name.toLowerCase()));
  if (byName) return byName.name;
  const byLabel = fields.find((f) => hint.label.test(f.label || '') || hint.label.test(f.name));
  return byLabel ? byLabel.name : null;
}

/* ------------------------------------------------------------------ *
 * État
 * ------------------------------------------------------------------ */

const state = {
  fields: [],     // schéma du jeu de données
  mapping: {},    // rôle -> nom de champ
  levels: [],     // champs formant l'arborescence, du plus large au plus fin
  path: [],       // { field, value, rank } — le chemin priorisé parcouru
  cards: [],      // cartes du niveau courant
  isLeaf: false,  // true quand on affiche des formations et non des groupes
  offset: 0,
  total: 0,
};

const el = (id) => document.getElementById(id);

const buildWhere = () =>
  state.path.map((step) => `${step.field} = ${quote(step.value)}`).join(' and ');

/* ------------------------------------------------------------------ *
 * Navigation
 * ------------------------------------------------------------------ */

async function loadLevel() {
  const field = state.levels[state.path.length];
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
      const data = await apiGet(`/catalog/datasets/${DATASET}/records`, {
        select: `${field} as valeur, count(*) as nb`,
        group_by: field,
        order_by: 'nb desc',
        where: buildWhere(),
        limit: PAGE_SIZE,
      });
      state.cards = (data.results || [])
        .filter((row) => row.valeur !== null && row.valeur !== '')
        .map((row) => ({ value: row.valeur }));
      state.total = state.cards.length;
    }
    setStatus(null);
  } catch (error) {
    state.cards = [];
    setStatus(`Impossible de joindre l'API : ${error.message}`, true);
  }
  render();
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
  const { etablissement, commune, fiche } = state.mapping;
  const url = fiche && /^https?:\/\//.test(record[fiche] || '') ? record[fiche] : null;
  return {
    value: record[etablissement] || 'Formation',
    meta: record[commune] || '',
    url,
  };
}

function descend(index) {
  state.path.push({
    field: state.levels[state.path.length],
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
  bar.hidden = !state.path.length;
  if (bar.hidden) return;

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

  // Une carte de groupe s'ouvre sur le niveau suivant ; une formation renvoie
  // vers sa fiche quand le jeu de données en fournit une.
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

  attachDrag(item);
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

function attachDrag(node) {
  const handle = node.querySelector('.drag-handle');

  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();

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
      move(state.cards, from, to);
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
      renderDeck();
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
 * Choix de secours des niveaux
 *
 * N'apparaît que si la détection automatique dans le schéma échoue.
 * ------------------------------------------------------------------ */

function renderFieldFallback() {
  const box = el('status');
  ['niveau1', 'niveau2'].forEach((role, position) => {
    const wrapper = document.createElement('label');
    wrapper.className = 'field-pick';
    wrapper.textContent = `Niveau ${position + 1}`;

    const select = document.createElement('select');
    select.append(new Option('— aucun —', ''));
    state.fields.forEach((field) => {
      select.append(new Option(`${field.label || field.name} (${field.name})`, field.name));
    });
    select.value = state.mapping[role] || '';
    select.addEventListener('change', () => {
      state.mapping[role] = select.value || null;
      state.levels = [state.mapping.niveau1, state.mapping.niveau2].filter(Boolean);
      if (state.levels.length) {
        state.path = [];
        loadLevel();
      }
    });

    wrapper.append(select);
    box.append(wrapper);
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

  // Diagnostic : ?schema affiche le dictionnaire des champs du jeu de données,
  // dont les noms sont trop courts pour être devinés.
  if (new URLSearchParams(location.search).has('schema')) {
    renderSchema();
    return;
  }

  for (const [role, hint] of Object.entries(HINTS)) {
    state.mapping[role] = detectField(state.fields, hint);
  }
  state.levels = [state.mapping.niveau1, state.mapping.niveau2].filter(Boolean);

  if (!state.levels.length) {
    setStatus('Niveaux non reconnus dans le jeu de données. Choisis-les :', true);
    renderFieldFallback();
    return;
  }

  await loadLevel();
}

el('load-more').addEventListener('click', loadMore);

start();
