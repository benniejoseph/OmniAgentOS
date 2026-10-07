# Memory map redesign

8 October 2026. Implemented for web and Flutter; visual verification belongs to the paired release.

## Why the old graph failed

The default view ranked extracted nodes by number of links. That elevated generic
words and task tags. Drawing all links between the selected nodes created a dense
network before a person had a useful question or even readable names. A different
force simulation would not fix the information problem.

The new default starts from the existing authorized Memory and Knowledge catalogs.
A branching collection map shows actual saved titles immediately, grouped as
preferences, decisions, experiences, documents, conversations and other familiar
categories. A category opens its loaded records; a record expands its metadata
beside the selected title and offers the existing memory/source detail flow.
The map is an organization view: its branches mean category membership, not a
factual or causal relationship. That distinction stays visible.

## Research and decisions

- [Yoghourdjian et al., Scalability of Network Visualisation from a Cognitive Load
  Perspective](https://arxiv.org/abs/2008.07944) studied topology tasks on networks
  of differing size and density. Its evidence supports aggregation and filtering
  when node-link diagrams become too complex. Our design choice is to avoid
  asking users to interpret a dense graph as their starting point.
- [D3's tidy tree reference](https://d3js.org/d3-hierarchy/tree) demonstrates a
  compact hierarchy with stable, separated nodes. We use that structural idea
  for collection membership, rendered with semantic HTML/CSS and native Flutter
  widgets. There is no additional D3 dependency and no claim that the underlying
  factual graph is a tree.
- [Obsidian's Graph view documentation](https://obsidian.md/help/plugins/graph)
  distinguishes the entire graph from the local graph centered on a selected
  note. The secondary Explore connections view keeps that focused behavior but
  replaces the force cloud with one stable selected item and up to 12 direct
  neighbors. Links between unrelated neighbors are not drawn.

## Scope and disclosure

Web opens at most 100 recent active memories or 100 source catalog records through
`/api/memory/intelligence`, with the existing tenant/actor authorization. Native
uses the already-authorized controller catalog and offers its existing bounded
pagination. Counts describe loaded records, not an invented total. Search is local
to loaded titles and categories. Archived, replaced and retired records stay
available in the existing library rather than crowding the default map.

The relationship graph's content-free bulk contract is unchanged. Exact node
names still require an explicit selected-item or bounded Open visible names
request. Identity fences, selection cancellation, owner guards and source-bound
read authority remain intact. All destructive controls continue through the
existing memory detail, deletion preview and final delete operation.

## Presentation

Wide layouts read left to right: collection, category, named records. Narrow
layouts keep categories and records in a vertical branch list with no tiny canvas
or required pan/zoom. Expanding a selected record happens in place. Theme tokens,
keyboard focus and reduced-motion behavior remain shared with Asael.

Live review should cover a real multi-category catalog, a single-category catalog,
source switching, category drill-down, title search, inline record details, Open
memory into the existing inspector, narrow screens and dark mode. Graph review
should open names, select an item, follow one direct neighbor, and change layers
without showing a previous selection's response.
