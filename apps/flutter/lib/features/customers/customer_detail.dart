import 'package:flutter/material.dart';

import '../../core/network/api_client.dart';
import '../../generated/native_contract.g.dart';

typedef Json = Map<String, dynamic>;

class CustomerDetailView extends StatefulWidget {
  const CustomerDetailView({super.key, required this.id, required this.api});

  final String id;
  final ApiClient api;

  @override
  State<CustomerDetailView> createState() => _CustomerDetailViewState();
}

class _CustomerDetailViewState extends State<CustomerDetailView> {
  CustomerDetail? customer;
  Object? error;
  bool loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      loading = true;
      error = null;
    });
    try {
      customer = CustomerDetail.fromJson(
        await widget.api.getJson(NativePaths.customersGet(widget.id)),
      );
    } catch (value) {
      error = value;
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final value = customer;
    return Scaffold(
      appBar: AppBar(
        title: Text(value?.name ?? 'Customer'),
        actions: [
          IconButton(
            tooltip: 'Refresh customer',
            onPressed: loading ? null : _load,
            icon: const Icon(Icons.refresh_rounded),
          ),
        ],
      ),
      body: loading && value == null
          ? const Center(child: CircularProgressIndicator())
          : error != null && value == null
          ? Center(
              child: FilledButton.tonalIcon(
                onPressed: _load,
                icon: const Icon(Icons.cloud_off_rounded),
                label: const Text('Reconnect customer'),
              ),
            )
          : value == null
          ? const Center(child: Text('This customer is unavailable.'))
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(
                padding: const EdgeInsets.fromLTRB(16, 16, 16, 40),
                children: [
                  Card(
                    child: Padding(
                      padding: const EdgeInsets.all(20),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            value.name,
                            style: Theme.of(context).textTheme.headlineSmall,
                          ),
                          const SizedBox(height: 10),
                          Wrap(
                            spacing: 8,
                            runSpacing: 8,
                            children: [
                              Chip(label: Text(_humanize(value.lifecycle))),
                              Chip(label: Text('Revision ${value.revision}')),
                              Chip(label: Text('${value.facts.length} facts')),
                            ],
                          ),
                        ],
                      ),
                    ),
                  ),
                  if (error != null)
                    Card(
                      color: Theme.of(context).colorScheme.errorContainer,
                      child: const Padding(
                        padding: EdgeInsets.all(14),
                        child: Text(
                          'Offline · showing the last available Customer 360 projection.',
                        ),
                      ),
                    ),
                  const SizedBox(height: 18),
                  Text(
                    'Evidence-backed facts',
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
                  const SizedBox(height: 8),
                  if (value.facts.isEmpty)
                    const Card(
                      child: Padding(
                        padding: EdgeInsets.all(20),
                        child: Text('No visible customer facts are available.'),
                      ),
                    )
                  else
                    for (final fact in value.facts)
                      Card(
                        child: ListTile(
                          leading: Icon(
                            fact.stale
                                ? Icons.history_toggle_off_rounded
                                : Icons.verified_outlined,
                          ),
                          title: Text(_humanize(fact.key)),
                          subtitle: Text(
                            '${fact.summary}\n${fact.source} · ${fact.confidence}% confidence${fact.stale ? ' · stale' : ''}',
                          ),
                          isThreeLine: true,
                        ),
                      ),
                ],
              ),
            ),
    );
  }
}

class CustomerDetail {
  const CustomerDetail({
    required this.id,
    required this.name,
    required this.lifecycle,
    required this.revision,
    required this.facts,
  });

  factory CustomerDetail.fromJson(Json response) {
    final projection = _map(response['account']);
    final account = _map(projection['account']);
    final id = account['accountId']?.toString() ?? '';
    final name = account['name']?.toString() ?? '';
    if (id.isEmpty || name.isEmpty) {
      throw const FormatException('The Customer 360 response is invalid.');
    }
    return CustomerDetail(
      id: id,
      name: name,
      lifecycle: account['lifecycle']?.toString() ?? 'unknown',
      revision: (account['revision'] as num?)?.toInt() ?? 0,
      facts: (projection['facts'] as List? ?? const [])
          .whereType<Map>()
          .map((value) => CustomerFact.fromJson(Json.from(value)))
          .toList(growable: false),
    );
  }

  final String id;
  final String name;
  final String lifecycle;
  final int revision;
  final List<CustomerFact> facts;
}

class CustomerFact {
  const CustomerFact({
    required this.key,
    required this.summary,
    required this.source,
    required this.confidence,
    required this.stale,
  });

  factory CustomerFact.fromJson(Json value) {
    final fact = _map(value['fact']);
    final freshness = _map(value['freshness']);
    final source = _map(fact['source']);
    final factValue = _map(fact['value']);
    return CustomerFact(
      key: fact['factKey']?.toString() ?? 'customer.fact',
      summary:
          factValue['summary']?.toString() ??
          factValue['status']?.toString() ??
          factValue['value']?.toString() ??
          'Recorded customer evidence',
      source:
          '${source['sourceKind'] ?? 'source'} · ${source['sourceId'] ?? 'unavailable'}',
      confidence:
          (((fact['confidenceBasisPoints'] as num?)?.toInt() ?? 0) / 100)
              .round(),
      stale: freshness['status'] != 'fresh',
    );
  }

  final String key;
  final String summary;
  final String source;
  final int confidence;
  final bool stale;
}

Json _map(Object? value) =>
    value is Map ? Json.from(value) : <String, dynamic>{};

String _humanize(String value) => value
    .split(RegExp(r'[._:-]'))
    .where((part) => part.isNotEmpty)
    .map((part) => '${part[0].toUpperCase()}${part.substring(1)}')
    .join(' ');
