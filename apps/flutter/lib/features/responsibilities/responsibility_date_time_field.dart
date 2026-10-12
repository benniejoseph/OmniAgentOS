import 'package:flutter/material.dart';

/// Date/time presentation only. The owning editor still validates and submits
/// its exact UTC value; a picker never changes scope or confirmation authority.
class ResponsibilityDateTimeField extends StatelessWidget {
  const ResponsibilityDateTimeField({
    super.key,
    required this.controller,
    required this.label,
    required this.isCurrent,
    required this.onChanged,
    this.optional = false,
  });
  final TextEditingController controller;
  final String label;
  final bool Function() isCurrent;
  final ValueChanged<String> onChanged;
  final bool optional;
  @override
  Widget build(BuildContext context) {
    final value = DateTime.tryParse(controller.text)?.toLocal();
    final locale = MaterialLocalizations.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: FormField<String>(
        key: ValueKey((controller, controller.text)),
        initialValue: controller.text,
        validator: (value) => !optional && (value == null || value.isEmpty)
            ? '$label is required.'
            : null,
        builder: (field) => InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: !isCurrent()
              ? null
              : () async {
                  final now = DateTime.now(),
                      first = DateTime(1900),
                      last = DateTime(2100, 12, 31);
                  final initial =
                      value == null ||
                          value.isBefore(first) ||
                          value.isAfter(last)
                      ? now
                      : value;
                  final day = await showDatePicker(
                    context: context,
                    initialDate: initial,
                    firstDate: first,
                    lastDate: last,
                  );
                  if (day == null || !context.mounted || !isCurrent()) return;
                  final time = await showTimePicker(
                    context: context,
                    initialTime: TimeOfDay.fromDateTime(initial),
                  );
                  if (time == null || !context.mounted || !isCurrent()) return;
                  final exact = DateTime(
                    day.year,
                    day.month,
                    day.day,
                    time.hour,
                    time.minute,
                  ).toUtc().toIso8601String();
                  controller.text = exact;
                  if (field.mounted) field.didChange(exact);
                  onChanged(exact);
                },
          child: InputDecorator(
            decoration: InputDecoration(
              labelText: label,
              helperText: 'Shown in this device’s local time',
              errorText: field.errorText,
              suffixIcon: optional && controller.text.isNotEmpty
                  ? IconButton(
                      tooltip: 'Clear $label',
                      onPressed: !isCurrent()
                          ? null
                          : () {
                              controller.clear();
                              field.didChange('');
                              onChanged('');
                            },
                      icon: const Icon(Icons.close_rounded),
                    )
                  : const Icon(Icons.calendar_today_outlined),
            ),
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 12),
              child: Text(
                value == null
                    ? optional
                          ? 'No date set'
                          : 'Choose date & time'
                    : '${locale.formatMediumDate(value)} · ${locale.formatTimeOfDay(TimeOfDay.fromDateTime(value))}',
              ),
            ),
          ),
        ),
      ),
    );
  }
}
