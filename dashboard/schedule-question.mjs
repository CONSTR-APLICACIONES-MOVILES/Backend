export function createScheduleImportQuestion() {
  return {
    id: 'bq9-google', type: 'Type 3 · Feature Analysis', owner: 'Gabriel Polania',
    doc: 'bq9_google_calendar_adoption',
    question: 'What percentage of all schedule slots in ParchApp originate from the Google Calendar import feature?',
    hasData: d => d.totalSlots > 0 && d.percentage != null,
    empty: 'No valid stored Schedule intervals yet. Import a calendar or save availability, then refresh. Adoption is not established.',
    methodology: 'All currently stored days, including history and future dates. One slot is a busy interval per owner/day, not an individual Google event. Overlaps and same-source adjacent intervals are merged; date snapshots take precedence over private slots, which take precedence over shared copies. Unknown sources remain in the denominator. This measures slots, not users.',
    render(d) {
      return {
        number: `${d.percentage}%`, detail: 'Google Calendar Adoption (%)',
        stats: [{label: 'Total Schedule Slots', value: d.totalSlots},
          {label: 'Google Calendar Slots', value: d.googleSlots},
          {label: 'Other Slots', value: d.otherSlots},
          {label: 'Unknown source', value: d.unknownSlots}],
        metrics: 'Google Calendar Slots / Total Schedule Slots × 100',
        method: this.methodology,
        note: d.unknownSlots > 0 ? `${d.unknownSlots} intervals have unknown or conflicting origins; they are not classified as other sources.` : undefined,
        chartType: 'doughnut',
        chart: {labels: ['Google Calendar slots', 'Other Schedule slots', 'Unknown source'],
          datasets: [{label: 'Stored busy intervals', data: [d.googleSlots, d.otherSlots, d.unknownSlots],
            backgroundColor: ['#2563EB', '#10B981', '#94A3B8']}]},
      };
    },
  };
}
