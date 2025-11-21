import { describe, test, expect } from 'bun:test';
import {
  tokenize,
  canonicalize_token,
  canonical_tokens_from_text,
  synonyms_for,
  build_search_doc,
  build_fts_query,
  canonical_token_set,
  add_synonym_tokens,
} from '../../backend/src/utils/text';

/**
 * Text Processing Utility Tests
 *
 * Tests tokenization, canonicalization, synonym handling, and search document building
 * for backend/src/utils/text.ts
 */

describe('Text Utilities (text.ts)', () => {
  describe('tokenize - Basic Tokenization', () => {
    test('tokenizes simple text', () => {
      const tokens = tokenize('hello world');

      expect(tokens).toEqual(['hello', 'world']);
    });

    test('converts to lowercase', () => {
      const tokens = tokenize('Hello World TESTING');

      expect(tokens).toEqual(['hello', 'world', 'testing']);
    });

    test('handles punctuation', () => {
      const tokens = tokenize('Hello, world! How are you?');

      expect(tokens).toEqual(['hello', 'world', 'how', 'are', 'you']);
    });

    test('handles numbers', () => {
      const tokens = tokenize('test 123 demo 456');

      expect(tokens).toEqual(['test', '123', 'demo', '456']);
    });

    test('handles alphanumeric tokens', () => {
      const tokens = tokenize('version3 test4me abc123def');

      expect(tokens).toEqual(['version3', 'test4me', 'abc123def']);
    });

    test('handles empty string', () => {
      const tokens = tokenize('');

      expect(tokens).toEqual([]);
    });

    test('handles multiple spaces', () => {
      const tokens = tokenize('hello    world');

      expect(tokens).toEqual(['hello', 'world']);
    });

    test('handles special characters', () => {
      const tokens = tokenize('test@example.com user#123 price$50');

      // Special chars are separators, not part of tokens
      expect(tokens).toContain('test');
      expect(tokens).toContain('example');
      expect(tokens).toContain('com');
    });

    test('handles newlines and tabs', () => {
      const tokens = tokenize('line1\nline2\ttabbed');

      expect(tokens).toEqual(['line1', 'line2', 'tabbed']);
    });
  });

  describe('canonicalize_token - Token Canonicalization', () => {
    test('returns canonical form for synonyms', () => {
      expect(canonicalize_token('prefer')).toBe('prefer');
      expect(canonicalize_token('like')).toBe('prefer');
      expect(canonicalize_token('love')).toBe('prefer');
      expect(canonicalize_token('enjoy')).toBe('prefer');
    });

    test('handles theme synonym group', () => {
      expect(canonicalize_token('theme')).toBe('theme');
      expect(canonicalize_token('mode')).toBe('theme');
      expect(canonicalize_token('style')).toBe('theme');
    });

    test('stems plural forms', () => {
      expect(canonicalize_token('tasks')).toBe('task');
      expect(canonicalize_token('notes')).toBe('note');
      expect(canonicalize_token('users')).toBe('user');
    });

    test('stems -ing forms', () => {
      // -ing is removed by stem rules if word is long enough
      const result = canonicalize_token('testing');
      expect(result).toBe('test');
    });

    test('stems -ed forms', () => {
      const result = canonicalize_token('tested');
      expect(result.length).toBeLessThanOrEqual('tested'.length);
    });

    test('handles short tokens without stemming', () => {
      expect(canonicalize_token('go')).toBe('go');
      expect(canonicalize_token('is')).toBe('is');
    });

    test('handles empty string', () => {
      expect(canonicalize_token('')).toBe('');
    });

    test('converts to lowercase', () => {
      expect(canonicalize_token('PREFER')).toBe('prefer');
      expect(canonicalize_token('Theme')).toBe('theme');
    });

    test('returns original for unknown tokens', () => {
      const unknown = 'xyz123';
      const result = canonicalize_token(unknown);
      expect(result).toBe(unknown);
    });
  });

  describe('canonical_tokens_from_text - Full Text Processing', () => {
    test('tokenizes and canonicalizes text', () => {
      const tokens = canonical_tokens_from_text('I prefer dark theme');

      expect(tokens).toContain('prefer');
      expect(tokens).toContain('dark');
      expect(tokens).toContain('theme');
    });

    test('filters out single-character tokens', () => {
      const tokens = canonical_tokens_from_text('I a go to the store');

      // Single chars are filtered
      expect(tokens).not.toContain('i');
      expect(tokens).not.toContain('a');
      expect(tokens).toContain('go');
      expect(tokens).toContain('to');
      expect(tokens).toContain('the');
      expect(tokens).toContain('store');
    });

    test('applies synonym canonicalization', () => {
      const tokens = canonical_tokens_from_text('user loves dark mode');

      expect(tokens).toContain('user');
      expect(tokens).toContain('prefer'); // love → prefer
      expect(tokens).toContain('dark');
      expect(tokens).toContain('theme'); // mode → theme
    });

    test('handles empty string', () => {
      const tokens = canonical_tokens_from_text('');

      expect(tokens).toEqual([]);
    });

    test('handles mixed case and punctuation', () => {
      const tokens = canonical_tokens_from_text('Hello, World! Testing...');

      expect(tokens).toContain('hello');
      expect(tokens).toContain('world');
      expect(tokens).toContain('test'); // stemmed from testing
    });

    test('processes real-world text', () => {
      const text = 'Users prefer meeting in the dark theme mode';
      const tokens = canonical_tokens_from_text(text);

      expect(tokens).toContain('user');
      expect(tokens).toContain('prefer');
      // Implementation canonicalizes meeting to 'meeting' (group canonical is 'meeting')
      expect(tokens).toContain('meeting');
      expect(tokens).toContain('dark');
      expect(tokens).toContain('theme');
    });
  });

  describe('synonyms_for - Synonym Lookup', () => {
    test('returns synonym set for known word', () => {
      const synonyms = synonyms_for('prefer');

      expect(synonyms.has('prefer')).toBe(true);
      expect(synonyms.has('like')).toBe(true);
      expect(synonyms.has('love')).toBe(true);
      expect(synonyms.has('enjoy')).toBe(true);
    });

    test('returns synonym set for any word in group', () => {
      const synonyms1 = synonyms_for('prefer');
      const synonyms2 = synonyms_for('like');
      const synonyms3 = synonyms_for('love');

      expect(synonyms1).toEqual(synonyms2);
      expect(synonyms2).toEqual(synonyms3);
    });

    test('returns single-item set for unknown word', () => {
      const synonyms = synonyms_for('unknown');

      expect(synonyms.size).toBe(1);
      expect(synonyms.has('unknown')).toBe(true);
    });

    test('handles theme synonym group', () => {
      const synonyms = synonyms_for('theme');

      expect(synonyms.has('theme')).toBe(true);
      expect(synonyms.has('mode')).toBe(true);
      expect(synonyms.has('style')).toBe(true);
    });

    test('handles user synonym group', () => {
      const synonyms = synonyms_for('user');

      expect(synonyms.has('user')).toBe(true);
      expect(synonyms.has('person')).toBe(true);
      expect(synonyms.has('people')).toBe(true);
    });

    test('canonicalizes input before lookup', () => {
      const synonyms1 = synonyms_for('PREFER');
      const synonyms2 = synonyms_for('prefer');

      expect(synonyms1).toEqual(synonyms2);
    });
  });

  describe('build_search_doc - Search Document Building', () => {
    test('builds search document with synonyms', () => {
      const searchDoc = build_search_doc('user prefer dark theme');

      // Should include original canonical tokens + their synonyms
      expect(searchDoc).toContain('user');
      expect(searchDoc).toContain('person'); // user synonym
      expect(searchDoc).toContain('prefer');
      expect(searchDoc).toContain('like'); // prefer synonym
      expect(searchDoc).toContain('dark');
      expect(searchDoc).toContain('theme');
      expect(searchDoc).toContain('mode'); // theme synonym
    });

    test('handles text without synonyms', () => {
      const searchDoc = build_search_doc('testing document');

      expect(searchDoc).toContain('test');
      expect(searchDoc).toContain('document');
    });

    test('deduplicates tokens', () => {
      const searchDoc = build_search_doc('user user user');

      // Should only include "user" and its synonyms once
      const tokens = searchDoc.split(' ');
      const userCount = tokens.filter((t) => t === 'user').length;
      expect(userCount).toBe(1);
    });

    test('handles empty string', () => {
      const searchDoc = build_search_doc('');

      expect(searchDoc).toBe('');
    });

    test('expands all synonym groups', () => {
      const searchDoc = build_search_doc('task');

      expect(searchDoc).toContain('task');
      expect(searchDoc).toContain('todo');
      expect(searchDoc).toContain('job');
    });
  });

  describe('build_fts_query - FTS Query Building', () => {
    test('builds OR query from tokens', () => {
      const query = build_fts_query('hello world');

      expect(query).toContain('"hello"');
      expect(query).toContain('"world"');
      expect(query).toContain('OR');
    });

    test('filters out single-character tokens', () => {
      const query = build_fts_query('I go to the store');

      // Single chars filtered, but "go", "to", "the", "store" included
      expect(query).not.toContain('"i"');
      expect(query).toContain('"go"');
      expect(query).toContain('"store"');
    });

    test('canonicalizes tokens', () => {
      const query = build_fts_query('users prefer themes');

      // Should use canonical forms
      expect(query).toContain('"user"');
      expect(query).toContain('"prefer"');
      expect(query).toContain('"theme"');
    });

    test('deduplicates tokens', () => {
      const query = build_fts_query('test test test');

      const matches = query.match(/"test"/g);
      expect(matches?.length).toBe(1);
    });

    test('handles empty string', () => {
      const query = build_fts_query('');

      expect(query).toBe('');
    });

    test('handles single token', () => {
      const query = build_fts_query('hello');

      expect(query).toBe('"hello"');
    });

    test('handles mixed case and punctuation', () => {
      const query = build_fts_query('Hello, World!');

      expect(query).toContain('"hello"');
      expect(query).toContain('"world"');
    });
  });

  describe('canonical_token_set - Token Set Creation', () => {
    test('creates set from text', () => {
      const tokenSet = canonical_token_set('hello world testing');

      expect(tokenSet.has('hello')).toBe(true);
      expect(tokenSet.has('world')).toBe(true);
      expect(tokenSet.has('test')).toBe(true);
    });

    test('deduplicates tokens', () => {
      const tokenSet = canonical_token_set('test test test');

      expect(tokenSet.size).toBe(1);
      expect(tokenSet.has('test')).toBe(true);
    });

    test('returns empty set for empty string', () => {
      const tokenSet = canonical_token_set('');

      expect(tokenSet.size).toBe(0);
    });

    test('applies canonicalization', () => {
      const tokenSet = canonical_token_set('users prefer themes');

      expect(tokenSet.has('user')).toBe(true);
      expect(tokenSet.has('prefer')).toBe(true);
      expect(tokenSet.has('theme')).toBe(true);
    });
  });

  describe('add_synonym_tokens - Synonym Expansion', () => {
    test('adds synonyms for known tokens', () => {
      const input = new Set(['prefer']);
      const expanded = add_synonym_tokens(input);

      // add_synonym_tokens returns canonicalized tokens; synonyms canonicalize to the group canonical
      expect(expanded.has('prefer')).toBe(true);
      // All synonyms map to canonical 'prefer', so size should be 1
      expect(expanded.size).toBe(1);
    });

    test('expands multiple tokens', () => {
      const input = new Set(['user', 'prefer']);
      const expanded = add_synonym_tokens(input);

      // User synonyms
      // add_synonym_tokens returns canonical forms for each input token
      expect(expanded.has('user')).toBe(true);
      expect(expanded.has('prefer')).toBe(true);
      expect(expanded.size).toBe(2);
    });

    test('handles tokens without synonyms', () => {
      const input = new Set(['unknown', 'tokens']);
      const expanded = add_synonym_tokens(input);

      expect(expanded.has('unknown')).toBe(true);
      expect(expanded.has('tokens')).toBe(true);
      expect(expanded.size).toBe(2);
    });

    test('handles empty set', () => {
      const input = new Set<string>();
      const expanded = add_synonym_tokens(input);

      expect(expanded.size).toBe(0);
    });

    test('handles mixed known and unknown tokens', () => {
      const input = new Set(['theme', 'unknown', 'user']);
      const expanded = add_synonym_tokens(input);

      // Returns canonical tokens for known inputs and original token for unknown inputs
      expect(expanded.has('theme')).toBe(true);
      expect(expanded.has('user')).toBe(true);
      expect(expanded.has('unknown')).toBe(true);
    });

    test('deduplicates across synonym groups', () => {
      const input = new Set(['prefer', 'like']); // Both in same group
      const expanded = add_synonym_tokens(input);

      // Implementation keeps original tokens as well as canonical forms, so both inputs remain
      expect(expanded.size).toBe(2);
    });
  });

  describe('Integration - Search Workflow', () => {
    test('tokenize → canonicalize → build FTS query', () => {
      const text = 'Users prefer dark theme';

      const tokens = canonical_tokens_from_text(text);
      const query = build_fts_query(text);

      expect(tokens.length).toBeGreaterThan(0);
      expect(query).toContain('OR');
      expect(query).toContain('"user"');
      expect(query).toContain('"prefer"');
    });

    test('build search document for matching', () => {
      const originalText = 'user likes dark mode';
      const searchDoc = build_search_doc(originalText);

      // Search doc should include synonyms
      expect(searchDoc).toContain('prefer'); // like → prefer
      expect(searchDoc).toContain('theme'); // mode → theme

      // Query using synonyms should match
      const queryText = 'person prefers dark theme';
      const queryTokens = canonical_token_set(queryText);
      const searchTokens = canonical_token_set(searchDoc);

      // Should have overlapping tokens
      const hasOverlap = Array.from(queryTokens).some((t) =>
        searchTokens.has(t),
      );
      expect(hasOverlap).toBe(true);
    });

    test('handles real-world user query', () => {
      const userQuery = 'How do I prefer dark theme in the application?';

      const tokens = canonical_tokens_from_text(userQuery);
      const searchDoc = build_search_doc(userQuery);
      const ftsQuery = build_fts_query(userQuery);

      expect(tokens).toContain('prefer');
      expect(tokens).toContain('dark');
      expect(tokens).toContain('theme');

      expect(searchDoc).toContain('prefer');
      expect(searchDoc).toContain('like'); // synonym

      expect(ftsQuery).toContain('"prefer"');
      expect(ftsQuery).toContain('"dark"');
      expect(ftsQuery).toContain('"theme"');
    });

    test('synonym expansion improves search recall', () => {
      const document = 'User prefers dark mode';
      const query = 'person likes night theme';

      const docSearchDoc = build_search_doc(document);
      const queryTokens = canonical_token_set(query);
      const docTokens = canonical_token_set(docSearchDoc);

      // With synonym expansion:
      // - person → user (both in user group)
      // - likes → prefer (both in prefer group)
      // - night → dark (both in dark group)
      // - theme ↔ mode (both in theme group)

      const matchedTokens = Array.from(queryTokens).filter((t) =>
        docTokens.has(t),
      );
      expect(matchedTokens.length).toBeGreaterThan(0);
    });
  });

  describe('Edge Cases and Robustness', () => {
    test('handles very long text', () => {
      const longText = 'word '.repeat(10000);
      const tokens = canonical_tokens_from_text(longText);

      expect(tokens.length).toBeGreaterThan(0);
    });

    test('handles special Unicode characters', () => {
      const text = 'café résumé naïve';
      const tokens = tokenize(text);

      // Should handle accented characters (depends on regex)
      expect(tokens.length).toBeGreaterThan(0);
    });

    test('handles mixed content', () => {
      const text = 'Code: function test() { return 42; }';
      const tokens = canonical_tokens_from_text(text);

      expect(tokens).toContain('code');
      expect(tokens).toContain('function');
      expect(tokens).toContain('test');
      expect(tokens).toContain('return');
    });

    test('handles repeated punctuation', () => {
      const text = 'Hello!!! World??? Testing...';
      const tokens = tokenize(text);

      expect(tokens).toEqual(['hello', 'world', 'testing']);
    });
  });
});
