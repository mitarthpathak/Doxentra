-- Storage only. Doxentra users, documents, graphs and jobs remain in MongoDB.
-- No anon/authenticated policies are granted: custom-auth callers receive
-- scoped signed URLs from the server-only service client.
insert into storage.buckets (id, name, public, file_size_limit)
values ('documents', 'documents', false, 52428800)
on conflict (id) do update
set public = false, file_size_limit = excluded.file_size_limit;

-- Supabase Storage enables RLS on storage.objects by default.
-- Do not add public SELECT/INSERT policies for this private bucket.
