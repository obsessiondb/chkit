Removing a codec while changing the type, default or comment emits `REMOVE CODEC` as its
own operation before the `MODIFY COLUMN`, which kept the old codec.
