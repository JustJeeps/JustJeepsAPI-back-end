## Setup Instructions for backend

1. Install dependencies by running the following command: `npm install`.

2. Create a PostgreSQL database with the name "FINAL_PROJECT" using the following command in your PostgreSQL terminal: CREATE DATABASE FINAL_PROJECT;
Make sure to use the username "development" and password "development" for your PostgreSQL database.

3. Set up your environment variables in a `.env` file. 

`DATABASE_URL="postgresql://development:development@localhost:5432/FINAL_PROJECT?schema=public"`

4. Generate the Prisma client by running the following command: `npx prisma generate`. This will update the generated client files based on the latest schema.

5. Run Prisma migrations to create the necessary database schema by running the following command: `npx prisma migrate dev --name init`.

6. Seed the database with data using one of the following commands:
- To seed the data using hard-coded data, run: `npm run seed-hard-code`. This will execute a script with hard-coded data to seed the database.
- To seed the data using an API, run: `npm run seed-api`. This will execute the API endpoints to seed the data.

7. Once the database is seeded, you can check the tables and data using Prisma Studio. 
Start Prisma Studio by running the following command: `npx prisma studio`. This will open Prisma Studio in your default web browser, where you can interact with the seeded data and verify the tables.
# JustJeepsAPI-back-end
