import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { Employee } from '@/modules/employees/entities/employee.entity';

/**
 * Lookup GLOBAL por `username`. **EXCEPCIÓN intencional a multi-tenant**:
 *
 *   `POST /auth/user` recibe `{ username, password }` sin tenant ID. Como
 *   `employees.username` es UNIQUE GLOBAL (analogía con `users.email`), el
 *   lookup necesario para el login NO puede filtrar por `company_id` — la
 *   company se RESUELVE a partir del employee encontrado.
 *
 *   Defensa en profundidad anti-enumeración: el caller (`AuthService.login`)
 *   nunca devuelve un mensaje distinto entre "username no existe" y "username
 *   existe pero password mal". Ambos casos se traducen al mismo
 *   `UnauthorizedException("Credenciales inválidas")`.
 *
 * Filtra `is_archived = false` y `login_enabled = true`: un employee
 * archivado o sin login habilitado NO debe poder autenticarse.
 *
 * Devuelve TODAS las columnas, incluido `password` — el caller lo necesita
 * para `argon2.verify`. El controller jamás recibe esta entidad cruda; solo
 * el `AuthService` la consume internamente.
 */
@Injectable()
export class FindEmployeeByUsernameAction {
  constructor(
    @InjectRepository(Employee)
    private readonly repo: Repository<Employee>,
  ) {}

  async execute(username: string): Promise<Employee | null> {
    return this.repo.findOne({
      where: { username, is_archived: false, login_enabled: true },
    });
  }
}
