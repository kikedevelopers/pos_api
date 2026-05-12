import { formatTicketNumber } from '../internal/format-ticket-number';

describe('formatTicketNumber', () => {
  it('pads number to 3 digits when no prefix/suffix', () => {
    expect(formatTicketNumber(null, null, 1)).toBe('001');
    expect(formatTicketNumber(null, null, 42)).toBe('042');
    expect(formatTicketNumber(null, null, 999)).toBe('999');
  });

  it('does not pad numbers larger than 3 digits', () => {
    expect(formatTicketNumber(null, null, 1234)).toBe('1234');
  });

  it('formats with prefix only (mirror PlacePos)', () => {
    expect(formatTicketNumber('F', null, 7)).toBe('F-007');
    expect(formatTicketNumber('NC', null, 12)).toBe('NC-012');
  });

  it('formats with suffix only', () => {
    expect(formatTicketNumber(null, 'A', 7)).toBe('007-A');
  });

  it('formats with prefix AND suffix', () => {
    expect(formatTicketNumber('A', 'B', 5)).toBe('A-005-B');
  });

  it('treats empty string like null (no separator)', () => {
    expect(formatTicketNumber('', '', 9)).toBe('009');
    expect(formatTicketNumber('', 'X', 9)).toBe('009-X');
    expect(formatTicketNumber('X', '', 9)).toBe('X-009');
  });

  it('treats undefined like null', () => {
    expect(formatTicketNumber(undefined, undefined, 5)).toBe('005');
  });
});
