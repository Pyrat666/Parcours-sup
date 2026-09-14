'use strict';

/* ------------------------------------------------------------------ *
 * Client Opendatasoft Explore v2.1
 * ------------------------------------------------------------------ */

const DATASET = 'fr-esr-cartographie_formations_parcoursup';

// Le même jeu de données est publié sur plusieurs portails ODS : si le
// premier ne répond pas, on bascule sur le suivant.
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
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status} — ${body.slice(0, 200)}`);
      }
      endpoint = base;
      return await response.json();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

const quote = (value) => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** Compte les enregistrements par valeur d'un champ : le matériau des cartes. */
async function fetchGroups(field, where) {
  const data = await apiGet(`/catalog/datasets/${DATASET}/records`, {
    select: `${field} as valeur, count(*) as nb`,
    group_by: field,
    order_by: 'nb desc',
    where,
    limit: PAGE_SIZE,
  });
  return (data.results || [])
    .filter((row) => row.valeur !== null && row.valeur !== '')
    .map((row) => ({ value: row.valeur, count: row.nb }));
}

async function fetchRecords(where, offset) {
  return apiGet(`/catalog/datasets/${DATASET}/records`, {
    where,
    limit: PAGE_SIZE,
    offset: Math.min(offset, MAX_OFFSET),
  });
}

/* ------------------------------------------------------------------ *
 * Détection des champs dans le schéma
 * ------------------------------------------------------------------ */

// Les noms de champs du jeu de données sont courts et peu explicites ; on les
// résout à partir du schéma renvoyé par l'API plutôt que de les coder en dur,
// et l'utilisateur peut corriger la détection depuis le panneau « Champs ».
const HINTS = {
  niveau1:       { names: ['tf', 'type_formation', 'typeformation'], label: /type\s*d[e']?\s*formation/i },
  niveau2:       { names: ['fl', 'fil', 'filiere', 'sous_filiere'],  label: /fili[eè]re|sp[ée]cialit[ée]/i },
  etablissement: { names: ['nm', 'etablissement', 'nom_etablissement', 'lib_etab'], label: /[ée]tablissement/i },
  commune:       { names: ['nmc', 'commune', 'ville', 'nom_commune'], label: /commune|ville/i },
  departement:   { names: ['dep', 'departement', 'dep_lib', 'nom_departement'], label: /d[ée]partement/i },
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
  fields: [],          // schéma du jeu de données
  mapping: {},         // rôle -> nom de champ
  levels: [],          // champs formant l'arborescence, du plus large au plus fin
  path: [],            // { field, value, rank } — le chemin priorisé parcouru
  cards: [],           // cartes du niveau courant
  isLeaf: false,       // true quand on affiche des formations et non des groupes
  offset: 0,
  total: 0,
  shortlist: [],
  query: '',
};

const el = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ *
 * Construction des requêtes
 * ------------------------------------------------------------------ */

function buildWhere() {
  const clauses = state.path.map((step) => `${step.field} = ${quote(step.value)}`);

  const term = state.query.trim();
  if (term) {
    const searchable = [state.mapping.etablissement, state.mapping.commune, state.mapping.departement]
      .filter(Boolean)
      .map((field) => `search(${field}, ${quote(term)})`);
    if (searchable.length) clauses.push(`(${searchable.join(' or ')})`);
  }

  return clauses.join(' and ');
}

/* ------------------------------------------------------------------ *
 * Navigation
 * ------------------------------------------------------------------ */

async function loadLevel() {
  const depth = state.path.length;
  const field = state.levels[depth];
  state.isLeaf = !field;
  state.offset = 0;

  setStatus('Chargement…');
  try {
    if (state.isLeaf) {
      const data = await fetchRecords(buildWhere(), 0);
      state.total = data.total_count || 0;
      state.cards = (data.results || []).map(toFormationCard);
    } else {
      state.cards = await fetchGroups(field, buildWhere());
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
  if (!state.isLeaf) return;
  state.offset += PAGE_SIZE;
  try {
    const data = await fetchRecords(buildWhere(), state.offset);
    state.cards = state.cards.concat((data.results || []).map(toFormationCard));
    render();
  } catch (error) {
    setStatus(`Chargement interrompu : ${error.message}`, true);
  }
}

function toFormationCard(record) {
  const { etablissement, commune, departement, niveau2, fiche } = state.mapping;
  // Les valeurs déjà portées par le fil d'Ariane n'ont pas à être répétées sur la carte.
  const inPath = new Set(state.path.map((step) => step.value));
  const meta = [record[niveau2], record[commune], record[departement]]
    .filter((value) => value && !inPath.has(value));
  const url = fiche && /^https?:\/\//.test(record[fiche] || '') ? record[fiche] : null;
  return {
    value: record[etablissement] || record[niveau2] || 'Formation',
    meta: meta.join(' · '),
    url,
    record,
  };
}

function descend(index) {
  const card = state.cards[index];
  state.path.push({
    field: state.levels[state.path.length],
    value: card.value,
    rank: index + 1,
  });
  loadLevel();
}

function goTo(depth) {
  state.path = state.path.slice(0, depth);
  loadLevel();
}

/* ------------------------------------------------------------------ *
 * Priorisation
 * ------------------------------------------------------------------ */

function move(list, from, to) {
  if (to < 0 || to >= list.length || from === to) return;
  const [item] = list.splice(from, 1);
  list.splice(to, 0, item);
}

/** Chaîne de rangs « 1.3.2 » : la priorité donnée à chaque étage du parcours. */
function priorityChain(rank) {
  return state.path.map((step) => step.rank).concat(rank).join('.');
}

function compareChains(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

function addToShortlist(index) {
  const card = state.cards[index];
  const chain = priorityChain(index + 1);
  const label = card.value;
  if (state.shortlist.some((item) => item.label === label && item.meta === card.meta)) return;
  state.shortlist.push({
    label,
    meta: card.meta || '',
    url: card.url || '',
    path: state.path.map((step) => step.value).join(' › '),
    chain,
  });
  state.shortlist.sort((a, b) => compareChains(a.chain, b.chain));
  renderShortlist();
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

function labelOf(fieldName) {
  const field = state.fields.find((f) => f.name === fieldName);
  return field ? (field.label || field.name) : fieldName;
}

function render() {
  renderBreadcrumb();
  renderDeck();
  renderShortlist();
}

function renderBreadcrumb() {
  const bar = el('breadcrumb');
  bar.replaceChildren();

  const root = document.createElement('button');
  root.type = 'button';
  root.className = 'crumb' + (state.path.length ? '' : ' current');
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
    crumb.innerHTML = `<span class="rank">#${step.rank}</span>`;
    crumb.append(document.createTextNode(step.value));
    crumb.addEventListener('click', () => goTo(depth + 1));

    bar.append(separator, crumb);
  });
}

function renderDeck() {
  const deck = el('deck');
  deck.replaceChildren();

  const depth = state.path.length;
  if (state.isLeaf) {
    el('deck-title').textContent = `Formations (${state.total})`;
    el('deck-help').textContent =
      'Classe les formations par préférence, puis ajoute celles que tu retiens à ta liste de vœux.';
  } else {
    el('deck-title').textContent = labelOf(state.levels[depth]);
    el('deck-help').textContent =
      'Glisse les cartes pour les classer par ordre de préférence, puis ouvre celle qui arrive en tête.';
  }

  if (!state.cards.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'Aucun résultat pour ce chemin.';
    deck.append(empty);
  }

  state.cards.forEach((card, index) => deck.append(buildCard(card, index)));

  el('deck-more').hidden = !(state.isLeaf && state.cards.length < state.total && state.offset < MAX_OFFSET);
}

function buildCard(card, index) {
  const item = document.createElement('li');
  item.className = 'card';
  item.draggable = true;
  item.dataset.index = String(index);

  const rank = document.createElement('div');
  rank.className = 'rank';
  rank.textContent = String(index + 1);

  const body = document.createElement('div');
  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = card.value;
  body.append(label);

  const metaText = state.isLeaf ? card.meta : `${card.count} formation${card.count > 1 ? 's' : ''}`;
  if (metaText) {
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = metaText;
    if (card.url) {
      meta.append(' · ');
      const link = document.createElement('a');
      link.href = card.url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = 'fiche';
      meta.append(link);
    }
    body.append(meta);
  }

  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.append(
    iconButton('↑', 'Monter', () => reorder(index, index - 1)),
    iconButton('↓', 'Descendre', () => reorder(index, index + 1)),
  );

  const main = document.createElement('button');
  main.type = 'button';
  if (state.isLeaf) {
    main.textContent = 'Retenir';
    main.addEventListener('click', () => addToShortlist(index));
  } else {
    main.textContent = 'Ouvrir';
    main.addEventListener('click', () => descend(index));
  }
  actions.append(main);

  item.append(rank, body, actions);
  attachDrag(item, () => state.cards, renderDeck);
  return item;
}

function iconButton(glyph, title, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'icon';
  button.title = title;
  button.setAttribute('aria-label', title);
  button.textContent = glyph;
  button.addEventListener('click', onClick);
  return button;
}

function reorder(from, to) {
  move(state.cards, from, to);
  renderDeck();
}

function renderShortlist() {
  const list = el('shortlist');
  list.replaceChildren();
  el('shortlist-count').textContent = String(state.shortlist.length);

  if (!state.shortlist.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'Rien retenu pour l’instant.';
    list.append(empty);
    return;
  }

  state.shortlist.forEach((item, index) => {
    const node = document.createElement('li');
    node.className = 'card';
    node.draggable = true;
    node.dataset.index = String(index);

    const rank = document.createElement('div');
    rank.className = 'rank';
    rank.textContent = String(index + 1);

    const body = document.createElement('div');
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = item.label;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = [item.path, item.meta].filter(Boolean).join(' · ');
    const priority = document.createElement('div');
    priority.className = 'priority';
    priority.textContent = `priorité ${item.chain}`;
    body.append(label, meta, priority);

    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.append(iconButton('✕', 'Retirer', () => {
      state.shortlist.splice(index, 1);
      renderShortlist();
    }));

    node.append(rank, body, actions);
    attachDrag(node, () => state.shortlist, renderShortlist);
    list.append(node);
  });
}

/* ------------------------------------------------------------------ *
 * Glisser-déposer
 * ------------------------------------------------------------------ */

let dragSource = null;

function attachDrag(node, getList, rerender) {
  node.addEventListener('dragstart', (event) => {
    dragSource = { list: getList(), index: Number(node.dataset.index), rerender };
    node.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', node.dataset.index);
  });

  node.addEventListener('dragend', () => {
    node.classList.remove('dragging');
    dragSource = null;
  });

  node.addEventListener('dragover', (event) => {
    if (!dragSource || dragSource.list !== getList()) return;
    event.preventDefault();
    node.classList.add('drop-target');
  });

  node.addEventListener('dragleave', () => node.classList.remove('drop-target'));

  node.addEventListener('drop', (event) => {
    node.classList.remove('drop-target');
    if (!dragSource || dragSource.list !== getList()) return;
    event.preventDefault();
    move(getList(), dragSource.index, Number(node.dataset.index));
    rerender();
  });
}

/* ------------------------------------------------------------------ *
 * Export
 * ------------------------------------------------------------------ */

function exportCsv() {
  if (!state.shortlist.length) return;
  const escape = (value) => `"${String(value).replace(/"/g, '""')}"`;
  const rows = [['rang', 'priorite', 'formation', 'chemin', 'details', 'fiche']];
  state.shortlist.forEach((item, index) => {
    rows.push([index + 1, item.chain, item.label, item.path, item.meta, item.url].map(escape));
  });

  const blob = new Blob(['﻿' + rows.map((row) => row.join(';')).join('\n')], {
    type: 'text/csv;charset=utf-8',
  });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'mes-voeux-parcoursup.csv';
  link.click();
  URL.revokeObjectURL(link.href);
}

/* ------------------------------------------------------------------ *
 * Panneau de configuration des champs
 * ------------------------------------------------------------------ */

const CONFIG_CONTROLS = {
  'cfg-l1': 'niveau1',
  'cfg-l2': 'niveau2',
  'cfg-etab': 'etablissement',
  'cfg-commune': 'commune',
};

function renderConfig() {
  for (const [id, role] of Object.entries(CONFIG_CONTROLS)) {
    const select = el(id);
    select.replaceChildren();

    const none = document.createElement('option');
    none.value = '';
    none.textContent = '— aucun —';
    select.append(none);

    state.fields.forEach((field) => {
      const option = document.createElement('option');
      option.value = field.name;
      option.textContent = `${field.label || field.name} (${field.name})`;
      option.selected = state.mapping[role] === field.name;
      select.append(option);
    });

    select.onchange = () => {
      state.mapping[role] = select.value || null;
      rebuildLevels();
      state.path = [];
      loadLevel();
    };
  }
}

function rebuildLevels() {
  state.levels = [state.mapping.niveau1, state.mapping.niveau2].filter(Boolean);
}

/* ------------------------------------------------------------------ *
 * Démarrage
 * ------------------------------------------------------------------ */

async function start() {
  setStatus('Lecture du schéma du jeu de données…');
  let metadata;
  try {
    metadata = await apiGet(`/catalog/datasets/${DATASET}`, {});
  } catch (error) {
    setStatus(
      `Impossible de lire le schéma (${error.message}). ` +
      'Si tu ouvres la page en file://, sers-la plutôt en HTTP local : les requêtes ' +
      'vers l’API sont bloquées par la politique CORS du navigateur sur file://.',
      true,
    );
    return;
  }

  state.fields = metadata.fields || metadata.dataset?.fields || [];
  if (!state.fields.length) {
    setStatus('Le schéma est vide : le jeu de données a peut-être changé d’identifiant.', true);
    return;
  }

  for (const [role, hint] of Object.entries(HINTS)) {
    state.mapping[role] = detectField(state.fields, hint);
  }
  rebuildLevels();
  renderConfig();

  if (!state.levels.length) {
    setStatus(
      'Aucun niveau d’arborescence détecté automatiquement. ' +
      'Ouvre le panneau « Champs » pour les choisir.',
      true,
    );
    el('config').hidden = false;
    el('toggle-config').setAttribute('aria-expanded', 'true');
    return;
  }

  await loadLevel();
}

el('reset').addEventListener('click', () => {
  state.path = [];
  state.query = '';
  el('search').value = '';
  loadLevel();
});

el('toggle-config').addEventListener('click', () => {
  const panel = el('config');
  panel.hidden = !panel.hidden;
  el('toggle-config').setAttribute('aria-expanded', String(!panel.hidden));
});

el('sort-count').addEventListener('click', () => {
  state.cards.sort((a, b) => (b.count || 0) - (a.count || 0));
  renderDeck();
});

el('sort-alpha').addEventListener('click', () => {
  state.cards.sort((a, b) => String(a.value).localeCompare(String(b.value), 'fr'));
  renderDeck();
});

el('load-more').addEventListener('click', loadMore);
el('export').addEventListener('click', exportCsv);

let searchTimer;
el('search').addEventListener('input', (event) => {
  clearTimeout(searchTimer);
  const value = event.target.value;
  searchTimer = setTimeout(() => {
    state.query = value;
    loadLevel();
  }, 350);
});

start();
