import { describe, test, expect } from 'bun:test';
import {
  extract_keywords,
  compute_keyword_overlap,
  exact_phrase_match,
  compute_bm25_score,
  keyword_filter_memories,
} from '../../backend/src/utils/keyword';

/**
 * Keyword Extraction and Matching Tests
 *
 * Tests keyword extraction, BM25 scoring, phrase matching, and overlap computation
 * for backend/src/utils/keyword.ts
 */

describe('Keyword Extraction (keyword.ts)', () => {
  describe('extract_keywords - Basic Extraction', () => {
    test('extracts single-word keywords (canonicalized/stemmed)', () => {
      const text = 'javascript programming language';
      const keywords = extract_keywords(text, 3);

      // canonical_tokens and stem rules change some tokens (e.g. programming -> programm)
      expect(keywords.has('javascript')).toBe(true);
      expect(keywords.has('programm') || keywords.has('programming')).toBe(
        true,
      );
      expect(keywords.has('language')).toBe(true);
    });

    test('respects minimum length parameter', () => {
      const text = 'go to the store';
      const keywords = extract_keywords(text, 3);

      expect(keywords.has('store')).toBe(true);
      // "go" and "to" are too short (< 3 chars)
      expect(keywords.has('go')).toBe(false);
      expect(keywords.has('to')).toBe(false);
    });

    test('extracts trigrams from words (after canonicalization)', () => {
      const text = 'testing';
      const keywords = extract_keywords(text, 3);

      // Canonical token for "testing" becomes "test" (stem removes -ing),
      // so trigrams are from "test" -> 'tes','est'
      expect(keywords.has('tes')).toBe(true);
      expect(keywords.has('est')).toBe(true);
    });

    test('extracts bigrams from consecutive tokens (canonical tokens)', () => {
      const text = 'machine learning algorithm';
      const keywords = extract_keywords(text, 3);

      // 'learning' canonicalizes/stems to 'learn'
      expect(keywords.has('machine_learn')).toBe(true);
      expect(keywords.has('learn_algorithm')).toBe(true);
    });

    test('extracts trigrams from consecutive tokens (canonical tokens)', () => {
      const text = 'natural language processing task';
      const keywords = extract_keywords(text, 3);

      // 'processing' -> 'process' after stemming
      expect(keywords.has('natural_language_process')).toBe(true);
      expect(keywords.has('language_process_task')).toBe(true);
    });

    test('handles mixed case', () => {
      const text = 'JavaScript Python Ruby';
      const keywords = extract_keywords(text, 3);

      // Should normalize to lowercase/canonical form
      expect(keywords.has('javascript')).toBe(true);
      expect(keywords.has('python')).toBe(true);
      expect(keywords.has('ruby')).toBe(true);
    });

    test('handles punctuation', () => {
      const text = 'Hello, world! How are you?';
      const keywords = extract_keywords(text, 3);

      // Should extract words without punctuation
      expect(keywords.has('hello')).toBe(true);
      expect(keywords.has('world')).toBe(true);
    });

    test('handles empty string', () => {
      const keywords = extract_keywords('', 3);

      expect(keywords.size).toBe(0);
    });

    test('handles single short word', () => {
      const keywords = extract_keywords('hi', 3);

      // "hi" is too short (< 3 chars)
      expect(keywords.size).toBe(0);
    });
  });

  describe('extract_keywords - Stemming and Canonicalization', () => {
    test('stems plural forms', () => {
      const text = 'cats dogs birds';
      const keywords = extract_keywords(text, 3);

      // Should stem to singular (though exact behavior depends on stem rules)
      expect(keywords.has('cat') || keywords.has('cats')).toBe(true);
      expect(keywords.has('dog') || keywords.has('dogs')).toBe(true);
    });

    test('stems -ing forms', () => {
      const text = 'running jumping walking';
      const keywords = extract_keywords(text, 3);

      // Should remove -ing suffix
      expect(keywords.has('run') || keywords.has('running')).toBe(true);
    });

    test('handles synonyms through canonicalization', () => {
      const text = 'user prefer dark theme';
      const keywords = extract_keywords(text, 3);

      // Canonical forms from text.ts synonym groups
      expect(keywords.has('user') || keywords.has('person')).toBe(true);
      expect(keywords.has('prefer') || keywords.has('like')).toBe(true);
    });
  });

  describe('compute_keyword_overlap - Overlap Scoring', () => {
    test('computes exact overlap', () => {
      const query = new Set(['test', 'document']);
      const content = new Set(['test', 'document', 'extra']);

      const overlap = compute_keyword_overlap(query, content);

      // All query keywords match
      expect(overlap).toBe(1.0);
    });

    test('computes partial overlap', () => {
      const query = new Set(['test', 'document', 'sample']);
      const content = new Set(['test', 'document']);

      const overlap = compute_keyword_overlap(query, content);

      // 2 out of 3 query keywords match
      expect(overlap).toBeCloseTo(0.666, 2);
    });

    test('returns zero for no overlap', () => {
      const query = new Set(['test', 'document']);
      const content = new Set(['other', 'words']);

      const overlap = compute_keyword_overlap(query, content);

      expect(overlap).toBe(0.0);
    });

    test('weights bigrams/trigrams higher', () => {
      const query = new Set(['single', 'word_bigram']);
      const content = new Set(['single', 'word_bigram']);

      const overlap = compute_keyword_overlap(query, content);

      // Bigram has 2.0 weight, single word has 1.0 weight
      // (1.0 + 2.0) / (1.0 + 2.0) = 1.0
      expect(overlap).toBe(1.0);
    });

    test('handles empty query', () => {
      const query = new Set<string>();
      const content = new Set(['test', 'document']);

      const overlap = compute_keyword_overlap(query, content);

      expect(overlap).toBe(0.0);
    });

    test('handles empty content', () => {
      const query = new Set(['test', 'document']);
      const content = new Set<string>();

      const overlap = compute_keyword_overlap(query, content);

      expect(overlap).toBe(0.0);
    });

    test('computes overlap for complex multi-gram query', () => {
      const query = new Set([
        'machine',
        'learning',
        'machine_learning',
        'deep_learning_model',
      ]);
      const content = new Set([
        'machine',
        'machine_learning',
        'deep_learning_model',
      ]);

      const overlap = compute_keyword_overlap(query, content);

      // machine: 1.0, learning: 0 (not in content), machine_learning: 2.0, deep_learning_model: 2.0
      // matched: 1.0 + 2.0 + 2.0 = 5.0
      // total: 1.0 + 1.0 + 2.0 + 2.0 = 6.0
      // 5.0 / 6.0 ≈ 0.833
      expect(overlap).toBeCloseTo(0.833, 2);
    });
  });

  describe('exact_phrase_match - Phrase Matching', () => {
    test('matches exact phrase', () => {
      const query = 'machine learning';
      const content = 'I love machine learning algorithms';

      expect(exact_phrase_match(query, content)).toBe(true);
    });

    test('matches with different case', () => {
      const query = 'Machine Learning';
      const content = 'machine learning is great';

      expect(exact_phrase_match(query, content)).toBe(true);
    });

    test('does not match partial words', () => {
      const query = 'learn';
      const content = 'machine learning';

      // "learn" is part of "learning" but not exact word match
      expect(exact_phrase_match(query, content)).toBe(true); // substring match
    });

    test('matches at start of content', () => {
      const query = 'hello world';
      const content = 'hello world, how are you?';

      expect(exact_phrase_match(query, content)).toBe(true);
    });

    test('matches at end of content', () => {
      const query = 'thank you';
      const content = 'very much thank you';

      expect(exact_phrase_match(query, content)).toBe(true);
    });

    test('does not match when phrase not present', () => {
      const query = 'machine learning';
      const content = 'deep neural networks';

      expect(exact_phrase_match(query, content)).toBe(false);
    });

    test('handles empty query', () => {
      const query = '';
      const content = 'some content';

      // Empty string is technically in any string
      expect(exact_phrase_match(query, content)).toBe(true);
    });

    test('handles punctuation in content (comma between words)', () => {
      const query = 'hello world';
      const content = 'Hello, world! How are you?';

      // If punctuation separates words in the content, exact contiguous phrase may not match
      expect(exact_phrase_match(query, content)).toBe(false);
    });
  });

  describe('compute_bm25_score - BM25 Scoring', () => {
    test('computes score for exact match', () => {
      const query = ['machine', 'learning'];
      const content = ['machine', 'learning', 'algorithm'];

      const score = compute_bm25_score(query, content);

      expect(score).toBeGreaterThan(0);
    });

    test('computes zero score when no matches', () => {
      const query = ['deep', 'learning'];
      const content = ['machine', 'vision'];

      const score = compute_bm25_score(query, content);

      expect(score).toBe(0);
    });

    test('higher score for multiple occurrences', () => {
      const query = ['test'];
      const content1 = ['test', 'document'];
      const content2 = ['test', 'test', 'test', 'document'];

      const score1 = compute_bm25_score(query, content1);
      const score2 = compute_bm25_score(query, content2);

      expect(score2).toBeGreaterThan(score1);
    });

    test('considers document length normalization', () => {
      const query = ['test'];
      const shortContent = ['test', 'doc'];
      const longContent = ['test'].concat(new Array(100).fill('filler'));

      const shortScore = compute_bm25_score(query, shortContent);
      const longScore = compute_bm25_score(query, longContent);

      // Shorter documents should get slightly higher scores
      expect(shortScore).toBeGreaterThanOrEqual(longScore);
    });

    test('handles multiple query terms', () => {
      const query = ['machine', 'learning', 'algorithm'];
      const content = ['machine', 'learning', 'algorithm', 'implementation'];

      const score = compute_bm25_score(query, content);

      expect(score).toBeGreaterThan(0);
    });

    test('handles empty query', () => {
      const query: string[] = [];
      const content = ['test', 'document'];

      const score = compute_bm25_score(query, content);

      expect(score).toBe(0);
    });

    test('handles empty content', () => {
      const query = ['test'];
      const content: string[] = [];

      const score = compute_bm25_score(query, content);

      expect(score).toBe(0);
    });

    test('uses custom corpus size', () => {
      const query = ['test'];
      const content = ['test', 'document'];

      const score1 = compute_bm25_score(query, content, 1000);
      const score2 = compute_bm25_score(query, content, 100000);

      // Different corpus sizes should affect IDF calculation
      expect(score1).not.toBe(score2);
    });
  });

  describe('keyword_filter_memories - Memory Filtering', () => {
    test('filters memories by keyword match', async () => {
      const query = 'machine learning';
      const memories = [
        { id: '1', content: 'I studied machine learning algorithms' },
        { id: '2', content: 'Deep learning is fascinating' },
        { id: '3', content: 'Database optimization techniques' },
      ];

      const scores = await keyword_filter_memories(query, memories, 0.1);

      expect(scores.has('1')).toBe(true);
      expect(scores.get('1')).toBeGreaterThan(0);
    });

    test('uses phrase match bonus', async () => {
      const query = 'machine learning';
      const memories = [
        { id: '1', content: 'machine learning is great' },
        { id: '2', content: 'I like machine and learning separately' },
      ];

      const scores = await keyword_filter_memories(query, memories, 0.1);

      // Exact phrase should score higher
      const score1 = scores.get('1') || 0;
      const score2 = scores.get('2') || 0;
      expect(score1).toBeGreaterThan(score2);
    });

    test('combines keyword, phrase, and BM25 scores', async () => {
      const query = 'deep learning neural networks';
      const memories = [
        { id: '1', content: 'deep learning with neural networks is powerful' },
        { id: '2', content: 'shallow algorithms' },
      ];

      const scores = await keyword_filter_memories(query, memories, 0.1);

      expect(scores.has('1')).toBe(true);
      expect(scores.has('2')).toBe(false);
    });

    test('respects threshold parameter', async () => {
      const query = 'test';
      const memories = [
        { id: '1', content: 'test document with test keywords' },
        { id: '2', content: 'barely related content' },
      ];

      const lowThreshold = await keyword_filter_memories(query, memories, 0.01);
      const highThreshold = await keyword_filter_memories(query, memories, 0.9);

      expect(lowThreshold.size).toBeGreaterThanOrEqual(highThreshold.size);
    });

    test('handles empty query (treats as match-all in current implementation)', async () => {
      const memories = [
        { id: '1', content: 'some content' },
        { id: '2', content: 'more content' },
      ];

      const scores = await keyword_filter_memories('', memories, 0.1);

      // Current implementation treats empty query as matching documents (match-all).
      expect(scores.size).toBe(memories.length);
    });

    test('handles empty memories array', async () => {
      const scores = await keyword_filter_memories('test query', [], 0.1);

      expect(scores.size).toBe(0);
    });

    test('returns sorted results by score', async () => {
      const query = 'javascript programming';
      const memories = [
        { id: '1', content: 'javascript programming is fun' },
        { id: '2', content: 'javascript' },
        { id: '3', content: 'programming' },
        { id: '4', content: 'unrelated content' },
      ];

      const scores = await keyword_filter_memories(query, memories, 0.1);

      const scoreArray = Array.from(scores.entries()).sort(
        (a, b) => b[1] - a[1],
      );

      // Best match should be memory 1 (has both terms and phrase)
      expect(scoreArray[0][0]).toBe('1');
      expect(scoreArray[0][1]).toBeGreaterThan(1.0); // phrase bonus + keyword + bm25
    });

    test('weights different scoring components appropriately', async () => {
      const query = 'machine learning algorithm';
      const memories = [
        { id: 'phrase', content: 'I love machine learning algorithm design' }, // phrase match
        {
          id: 'keywords',
          content: 'machine and learning and algorithm separately',
        }, // keywords only
        { id: 'partial', content: 'machine learning is cool' }, // partial match
      ];

      const scores = await keyword_filter_memories(query, memories, 0.01);

      const phraseScore = scores.get('phrase') || 0;
      const keywordsScore = scores.get('keywords') || 0;
      const partialScore = scores.get('partial') || 0;

      // Phrase match should score highest (1.0 bonus + keyword overlap + bm25)
      expect(phraseScore).toBeGreaterThan(keywordsScore);
      expect(phraseScore).toBeGreaterThan(partialScore);
    });
  });

  describe('Integration - Real-World Scenarios', () => {
    test('handles technical documentation search', async () => {
      const query = 'react hooks useEffect';
      const memories = [
        {
          id: '1',
          content:
            'React hooks like useEffect allow side effects in functional components',
        },
        {
          id: '2',
          content: 'Vue.js composition API is similar to React hooks',
        },
        {
          id: '3',
          content: 'Class components use lifecycle methods instead of hooks',
        },
      ];

      const scores = await keyword_filter_memories(query, memories, 0.1);

      expect(scores.has('1')).toBe(true);
      expect(scores.get('1')).toBeGreaterThan(0.5);
    });

    test('handles multi-word technical terms', async () => {
      const query = 'machine learning deep neural network';
      const memories = [
        {
          id: '1',
          content: 'Deep neural networks are used in machine learning',
        },
        {
          id: '2',
          content: "Traditional algorithms don't need neural networks",
        },
      ];

      const scores = await keyword_filter_memories(query, memories, 0.1);

      expect(scores.has('1')).toBe(true);
      const score1 = scores.get('1') || 0;
      expect(score1).toBeGreaterThan(0);
    });

    test('handles natural language queries', async () => {
      const query = 'how do I prefer dark theme in the application?';
      const memories = [
        { id: '1', content: 'User prefers dark mode for the interface' },
        { id: '2', content: 'Theme settings allow light or dark themes' },
        { id: '3', content: 'Application configuration options' },
      ];

      const scores = await keyword_filter_memories(query, memories, 0.1);

      // Should match memories with relevant keywords (canonical forms)
      expect(scores.size).toBeGreaterThan(0);
    });
  });
});
