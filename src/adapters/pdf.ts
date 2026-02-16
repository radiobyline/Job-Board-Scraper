import type { Posting } from '../monitor/types.js';
import { stablePostingId } from './common.js';

export async function scrapePdf(jobsUrl: string): Promise<Posting[]> {
  const decodedTail = decodeURIComponent(jobsUrl.split('/').pop() ?? 'Employment Opportunities');
  const title = decodedTail.replace(/\.pdf($|[?#].*)/i, '').replace(/[-_]+/g, ' ').trim();

  return [
    {
      posting_id: stablePostingId(undefined, jobsUrl),
      title: title || 'Employment Opportunities (PDF)',
      url: jobsUrl,
      snippet: 'PDF job postings source.',
      attribution_text: title || 'Employment Opportunities PDF',
    },
  ];
}
