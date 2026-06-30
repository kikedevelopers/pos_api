// Catálogo canónico de permisos de ACCESO A MÓDULOS.
//
// FUENTE DE VERDAD: este archivo debe permanecer IDÉNTICO (mismas keys, mismo
// orden, mismas secciones y etiquetas) a su gemelo en placepos
// (`src/main/database/permissions/permissionCatalog.ts`). La paridad es
// crítica: roles creados/serializados en un lado deben interpretarse igual en
// el otro. NO reordenar ni renombrar keys sin replicar el cambio en placepos.
//
// Estos permisos controlan únicamente la VISIBILIDAD/ACCESO a módulos del
// sistema. owner/superadmin siempre tienen acceso total y no dependen de este
// catálogo; sólo los empleados con rol personalizado se restringen por estas
// keys.
//
// NOTA: `canAccessLicenses` NO entra en el catálogo a propósito: es un módulo
// interno de desarrollo, nunca asignable a un rol de usuario.

/**
 * Las 22 keys EXACTAS, en su orden canónico. El orden importa para la paridad
 * con placepos y para derivar el set "todos los permisos" del rol Administrador.
 *
 * NOTA sobre `canViewAllSales`: a diferencia del resto (que controla VISIBILIDAD
 * de un módulo), esta key es de ALCANCE DE DATOS — si el rol la tiene, ve las
 * ventas de TODOS los cajeros (igual que el owner); si no, solo las suyas. Vive
 * en el catálogo para reusar la maquinaria de resolución/asignación de permisos.
 */
export const PERMISSION_KEYS = [
  'canAccessDashboard',
  'canAccessPOS',
  'canAccessInventory',
  'canAccessPackaging',
  'canAccessCategories',
  'canAccessBanks',
  'canAccessWallets',
  'canAccessCustomers',
  'canAccessEmployees',
  'canAccessCarriers',
  'canAccessSuppliers',
  'canAccessPurchase',
  'canAccessSalesReport',
  'canAccessCreditsReport',
  'canAccessComparativeReport',
  'canAccessDailyClosureReport',
  'canAccessCashierReport',
  'canAccessClientsReport',
  'canViewAllSales',
  'canAccessExpenses',
  'canAccessFixedExpenses',
  'canAccessSettings',
] as const;

/** Tipo de una key de permiso válida, derivado del array canónico. */
export type PermissionKey = (typeof PERMISSION_KEYS)[number];

/**
 * Un permiso individual dentro de una sección: la key técnica + su etiqueta de
 * presentación en español.
 */
export interface PermissionItem {
  key: PermissionKey;
  label: string;
}

/**
 * Una sección agrupa permisos afines bajo un título. El orden de las secciones
 * y de sus items es parte del contrato de paridad con placepos.
 */
export interface PermissionSection {
  title: string;
  items: PermissionItem[];
}

/** Agrupación de los 22 permisos en secciones, en el orden EXACTO acordado. */
export const PERMISSION_SECTIONS: readonly PermissionSection[] = [
  {
    title: 'General',
    items: [
      { key: 'canAccessDashboard', label: 'Inicio' },
      { key: 'canAccessPOS', label: 'Punto de venta' },
    ],
  },
  {
    title: 'Catálogos',
    items: [
      { key: 'canAccessInventory', label: 'Productos' },
      { key: 'canAccessPackaging', label: 'Empaques' },
      { key: 'canAccessCategories', label: 'Categorías' },
    ],
  },
  {
    title: 'Tesorería',
    items: [
      { key: 'canAccessBanks', label: 'Bancos' },
      { key: 'canAccessWallets', label: 'Billeteras' },
    ],
  },
  {
    title: 'Terceros',
    items: [
      { key: 'canAccessCustomers', label: 'Clientes' },
      { key: 'canAccessEmployees', label: 'Empleados' },
      { key: 'canAccessCarriers', label: 'Transportistas' },
    ],
  },
  {
    title: 'Proveedores',
    items: [
      { key: 'canAccessSuppliers', label: 'Proveedores' },
      { key: 'canAccessPurchase', label: 'Compras' },
    ],
  },
  {
    title: 'Informes',
    items: [
      { key: 'canAccessSalesReport', label: 'Ventas' },
      { key: 'canAccessCreditsReport', label: 'Cartera' },
      { key: 'canAccessComparativeReport', label: 'Comparativa' },
      { key: 'canAccessDailyClosureReport', label: 'Finanzas' },
      { key: 'canAccessCashierReport', label: 'Cajeros' },
      { key: 'canAccessClientsReport', label: 'Clientes' },
      { key: 'canViewAllSales', label: 'Ver ventas de todos los cajeros' },
    ],
  },
  {
    title: 'Operación',
    items: [
      { key: 'canAccessExpenses', label: 'Gastos variables y Domiciliarios' },
      { key: 'canAccessFixedExpenses', label: 'Gastos fijos' },
    ],
  },
  {
    title: 'Sistema',
    items: [{ key: 'canAccessSettings', label: 'Configuración' }],
  },
];

/**
 * Permisos LEGACY de un empleado SIN rol personalizado asignado (fallback).
 *
 * Cuando un `Employee` no tiene `role_id` (o el rol referenciado no se
 * encuentra), `resolveEffectivePermissions` cae a este set. Reproduce el
 * acceso histórico de PlacePos para empleados antes de existir el sistema de
 * roles personalizados, de modo que las cuentas viejas no pierdan acceso al
 * migrar.
 *
 * PARIDAD: debe permanecer IDÉNTICO (mismas keys, mismo orden) a su gemelo en
 * placepos. NO reordenar ni cambiar sin replicar el cambio allá.
 *
 * NOTA: `canAccessCreditsReport`, `canAccessComparativeReport` y
 * `canAccessFixedExpenses` se incluyen para PRESERVAR el acceso histórico: antes
 * de separarse, `canAccessSalesReport` encendía Ventas+Cartera+Comparativa y
 * `canAccessExpenses` incluía los gastos fijos. NO se incluye `canViewAllSales`:
 * el empleado legacy históricamente solo veía sus propias ventas.
 */
export const LEGACY_EMPLOYEE_PERMISSIONS: PermissionKey[] = [
  'canAccessPOS',
  'canAccessInventory',
  'canAccessPackaging',
  'canAccessCategories',
  'canAccessCustomers',
  'canAccessCarriers',
  'canAccessSalesReport',
  'canAccessCreditsReport',
  'canAccessComparativeReport',
  'canAccessClientsReport',
  'canAccessExpenses',
  'canAccessFixedExpenses',
];

/** Set de búsqueda O(1) para validación. Se construye una sola vez al cargar. */
const PERMISSION_KEY_SET: ReadonlySet<string> = new Set(PERMISSION_KEYS);

/**
 * Type guard: indica si una cadena arbitraria es una key de permiso válida del
 * catálogo. Útil para validar entradas antes de persistir un rol.
 */
export function isValidPermissionKey(key: unknown): key is PermissionKey {
  return typeof key === 'string' && PERMISSION_KEY_SET.has(key);
}
